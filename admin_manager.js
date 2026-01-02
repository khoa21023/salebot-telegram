require('dotenv').config(); // <--- THÊM DÒNG NÀY Ở DÒNG 1

const { Telegraf, Markup } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const xlsx = require('xlsx');
const axios = require('axios');
const fs = require('fs');

// ================= 1. CẤU HÌNH =================
const CONFIG = {
    // ⚠️ ĐIỀN TOKEN BOT ADMIN
    BOT_TOKEN: process.env.BOT_TOKEN, 
    SHEET_ID: process.env.SHEET_ID,
    GOOGLE_EMAIL: process.env.GOOGLE_EMAIL,
    // Xử lý xuống dòng cho Key
    GOOGLE_KEY: process.env.GOOGLE_KEY ? process.env.GOOGLE_KEY.replace(/\\n/g, '\n') : '',
    
    // Lấy Admin ID từ nhiều biến env nếu cần
    ADMIN_ID: [ 
        parseInt(process.env.ADMIN_ID_1),
        parseInt(process.env.ADMIN_ID_2)
    ].filter(Boolean), // Lọc bỏ giá trị rỗng
};

// ================= 2. KHỞI TẠO =================
const bot = new Telegraf(CONFIG.BOT_TOKEN);

const serviceAccountAuth = new JWT({
    email: CONFIG.GOOGLE_EMAIL,
    key: CONFIG.GOOGLE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(CONFIG.SHEET_ID, serviceAccountAuth);

const adminState = new Map();

// ================= 3. MIDDLEWARE =================
bot.use(async (ctx, next) => {
    const userId = ctx.from ? ctx.from.id : (ctx.callbackQuery ? ctx.callbackQuery.from.id : 0);
    if (!CONFIG.ADMIN_ID.includes(userId)) return ctx.reply('⛔ Bạn không có quyền Admin.');
    await next();
});

// ================= 4. MENU CHÍNH =================
async function showMainMenu(ctx) {
    adminState.delete(ctx.from.id);
    const menuText = '👮‍♂️ <b>QUẢN LÝ KHO (BULK MODE)</b>\nChọn tính năng:';
    const buttons = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Thêm Mặt Hàng (Nhiều dòng)', 'menu_add_prod_bulk')],
        [Markup.button.callback('📦 Thêm Kho (Text/Excel)', 'menu_add_stock')],
        [Markup.button.callback('🔍 Tra cứu', 'menu_search')]
    ]);

    if (ctx.callbackQuery) await ctx.editMessageText(menuText, { parse_mode: 'HTML', ...buttons });
    else await ctx.reply(menuText, { parse_mode: 'HTML', ...buttons });
}

bot.start(showMainMenu);
bot.action('back_to_main', (ctx) => showMainMenu(ctx));

// ================= 5. TÍNH NĂNG: THÊM MẶT HÀNG (BULK) =================
bot.action('menu_add_prod_bulk', (ctx) => {
    adminState.set(ctx.from.id, { action: 'ADD_PROD_BULK' });
    ctx.editMessageText(
        `➕ <b>THÊM NHIỀU MẶT HÀNG</b>\n` +
        `Bạn hãy gửi danh sách theo định dạng:\n` +
        `<b>Tên Hàng | Giá</b>\n` +
        `(Mỗi mặt hàng một dòng, ID sẽ tự động tạo)\n\n` +
        `<i>Ví dụ:</i>\n` +
        `<code>Netflix 1 Tháng | 20000\nYoutube Premium | 15000\nSpotify | 10000</code>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Quay lại', 'back_to_main')]]) }
    );
});

// ================= 6. TÍNH NĂNG: THÊM KHO (TEXT/EXCEL) =================
bot.action('menu_add_stock', async (ctx) => {
    await ctx.answerCbQuery('⏳ Đang tải...');
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['MatHang'];
        const rows = await sheet.getRows();
        
        if (rows.length === 0) return ctx.reply('❌ Chưa có mặt hàng nào.');

        const buttons = rows.map(row => [
            Markup.button.callback(row.get('ten_hang'), `add_stock_select_${row.get('id')}`)
        ]);
        buttons.push([Markup.button.callback('🔙 Quay lại', 'back_to_main')]);
        
        await ctx.editMessageText('👇 Chọn loại hàng cần nạp kho:', Markup.inlineKeyboard(buttons));
    } catch (e) { ctx.reply('❌ Lỗi: ' + e.message); }
});

bot.action(/add_stock_select_(.+)/, async (ctx) => {
    const pid = ctx.match[1];
    adminState.set(ctx.from.id, { action: 'ADD_STOCK_INPUT', pid: pid });
    await ctx.editMessageText(
        `📦 <b>NẠP KHO: ${pid}</b>\n\n` +
        `1️⃣ <b>Cách 1 (Text):</b> Dán danh sách <code>User|Pass</code> (mỗi acc 1 dòng).\n` +
        `2️⃣ <b>Cách 2 (Excel):</b> Gửi file <code>.xlsx</code> (Cột A là User, Cột B là Pass).\n\n` +
        `👇 Gửi dữ liệu ngay bây giờ:`, 
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Quay lại', 'back_to_main')]]) }
    );
});

// ================= 7. TRA CỨU =================
bot.action('menu_search', (ctx) => {
    adminState.set(ctx.from.id, { action: 'SEARCH' });
    ctx.editMessageText('🔍 Gửi <b>Mã đơn</b> hoặc <b>User ID</b> để tìm:', { parse_mode: 'HTML' });
});

// Hàm làm sạch dữ liệu để tránh lỗi Google Sheet Injection
function sanitize(str) {
    if (!str) return str;
    str = String(str);
    // Nếu bắt đầu bằng = + - @ (ký tự công thức), thêm dấu ' để biến thành text thường
    if (['=', '+', '-', '@'].includes(str.charAt(0))) {
        return "'" + str;
    }
    return str;
}

// ================= 8. XỬ LÝ TEXT (DÁN NHIỀU DÒNG) =================
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    if (!adminState.has(userId)) return showMainMenu(ctx);
    const state = adminState.get(userId);

    // --- LOGIC THÊM MẶT HÀNG (BULK) ---
    if (state.action === 'ADD_PROD_BULK') {
        const lines = text.split('\n');
        const newRows = [];
        let count = 0;

        await ctx.reply(`⏳ Đang xử lý ${lines.length} dòng...`);

        try {
            await doc.loadInfo();
            const sheet = doc.sheetsByTitle['MatHang'];
            const rows = await sheet.getRows();

            // Tìm Max ID hiện tại
            let maxId = 0;
            rows.forEach(r => {
                const num = parseInt(r.get('id').replace(/\D/g, ''));
                if (!isNaN(num) && num > maxId) maxId = num;
            });

            for (const line of lines) {
                const parts = line.split('|');
                if (parts.length >= 2) {
                    maxId++;
                    newRows.push({
                        id: `p${maxId}`,
                        ten_hang: sanitize(parts[0].trim()),
                        gia: parts[1].trim().replace(/\D/g, '')
                    });
                    count++;
                }
            }

            if (newRows.length > 0) {
                await sheet.addRows(newRows); // Thêm 1 lần cho nhanh
                ctx.reply(`✅ Đã thêm thành công <b>${count}</b> mặt hàng mới!`, { parse_mode: 'HTML' });
            } else {
                ctx.reply('⚠️ Không đọc được dòng nào hợp lệ (Tên|Giá).');
            }
        } catch (e) { ctx.reply('❌ Lỗi: ' + e.message); }
        return showMainMenu(ctx);
    }

    // --- LOGIC NẠP KHO (TEXT BULK) ---
    if (state.action === 'ADD_STOCK_INPUT') {
        const lines = text.split('\n');
        const rowsToAdd = [];
        const pid = state.pid;

        const msg = await ctx.reply(`⏳ Đang kiểm tra ${lines.length} tài khoản...`);

        try {
            await doc.loadInfo();
            const sheet = doc.sheetsByTitle['KhoHang'];
            const currentRows = await sheet.getRows();
            
            // Lấy danh sách username hiện có của loại hàng này để check trùng
            const existingUsers = new Set(
                currentRows
                .filter(r => r.get('loai_hang') === pid)
                .map(r => r.get('username'))
            );

            let addedCount = 0;
            let dupCount = 0;

            for (const line of lines) {
                if (!line.includes('|')) continue;
                const [user, pass] = line.split('|').map(s => s.trim());
                
                if (existingUsers.has(user)) {
                    dupCount++;
                } else {
                    rowsToAdd.push({
                        loai_hang: pid,
                        username: sanitize(user),
                        password: sanitize(pass),
                        status: 'chưa bán'
                    });
                    existingUsers.add(user); // Add vào set để check trùng trong chính lô này
                    addedCount++;
                }
            }

            if (rowsToAdd.length > 0) {
                await sheet.addRows(rowsToAdd); // Thêm hàng loạt (Batch insert)
                await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, 
                    `✅ <b>NẠP THÀNH CÔNG!</b>\n` +
                    `📦 Loại hàng: ${pid}\n` +
                    `➕ Đã thêm: <b>${addedCount}</b> acc\n` +
                    `🚫 Trùng lặp (Bỏ qua): <b>${dupCount}</b> acc`,
                    { parse_mode: 'HTML' }
                );
            } else {
                await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '⚠️ Không có acc nào được thêm (Lỗi định dạng hoặc Trùng hết).');
            }
            
            // Hiện lại menu nạp tiếp
            ctx.reply('👇 Gửi tiếp danh sách khác hoặc bấm nút để thoát.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Quay về Menu', 'back_to_main')]]));

        } catch (e) {
            ctx.reply('❌ Lỗi hệ thống: ' + e.message);
        }
    }

    // --- TRA CỨU ---
    if (state.action === 'SEARCH') {
        // ... (Giữ nguyên logic tra cứu cũ của bạn ở đây) ...
        // Bạn có thể copy lại phần tra cứu từ code cũ nếu cần
    }
});

// ================= 9. XỬ LÝ FILE EXCEL (DOCUMENT) =================
bot.on('document', async (ctx) => {
    const userId = ctx.from.id;
    if (!adminState.has(userId)) return;
    const state = adminState.get(userId);

    // Chỉ xử lý khi đang ở bước NẠP KHO
    if (state.action === 'ADD_STOCK_INPUT') {
        const file = ctx.message.document;
        const fileName = file.file_name.toLowerCase();

        // Check đuôi file
        if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls')) {
            return ctx.reply('⚠️ Vui lòng gửi file Excel (.xlsx hoặc .xls)');
        }

        const msg = await ctx.reply('⏳ Đang tải và đọc file Excel...');

        try {
            // 1. Lấy link tải file từ Telegram
            const fileLink = await ctx.telegram.getFileLink(file.file_id);
            
            // 2. Tải file về dạng Buffer
            const response = await axios({
                url: fileLink.href,
                method: 'GET',
                responseType: 'arraybuffer'
            });

            // 3. Đọc file Excel
            const workbook = xlsx.read(response.data, { type: 'buffer' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            
            // Chuyển thành JSON (Mảng các dòng)
            // header: 1 nghĩa là lấy dạng mảng mảng [ ['user', 'pass'], ['u1', 'p1'] ]
            const rawData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

            // 4. Xử lý dữ liệu
            const rowsToAdd = [];
            const pid = state.pid;
            
            await doc.loadInfo();
            const sheet = doc.sheetsByTitle['KhoHang'];
            const currentRows = await sheet.getRows();
            const existingUsers = new Set(currentRows.filter(r => r.get('loai_hang') === pid).map(r => r.get('username')));

            let addedCount = 0;
            let dupCount = 0;

            // Bắt đầu duyệt từ dòng (rawData có thể chứa header, ta nên check kỹ)
            for (const row of rawData) {
                // row[0] là User, row[1] là Pass
                if (!row[0] || !row[1]) continue; 
                
                const user = String(row[0]).trim();
                const pass = String(row[1]).trim();

                // Bỏ qua dòng tiêu đề nếu có (ví dụ dòng chứa chữ "username" hoặc "user")
                if (user.toLowerCase().includes('user') && pass.toLowerCase().includes('pass')) continue;

                if (existingUsers.has(user)) {
                    dupCount++;
                } else {
                    rowsToAdd.push({
                        loai_hang: pid,
                        username: sanitize(user),
                        password: sanitize(pass),
                        status: 'chưa bán'
                    });
                    existingUsers.add(user);
                    addedCount++;
                }
            }

            if (rowsToAdd.length > 0) {
                await sheet.addRows(rowsToAdd);
                await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, 
                    `✅ <b>NẠP FILE EXCEL THÀNH CÔNG!</b>\n` +
                    `📦 Loại hàng: ${pid}\n` +
                    `➕ Đã thêm: <b>${addedCount}</b> acc\n` +
                    `🚫 Trùng lặp: <b>${dupCount}</b> acc`,
                    { parse_mode: 'HTML' }
                );
            } else {
                await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '⚠️ File không có dữ liệu hợp lệ hoặc trùng hết.');
            }
             ctx.reply('👇 Gửi tiếp file khác hoặc bấm nút để thoát.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Quay về Menu', 'back_to_main')]]));

        } catch (e) {
            console.error(e);
            ctx.reply('❌ Lỗi đọc file: ' + e.message);
        }
    }
});

bot.launch();
console.log('👮‍♂️ Admin Manager (Bulk + Excel) Running...');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));