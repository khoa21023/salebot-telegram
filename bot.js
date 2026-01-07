const { Telegraf, Markup } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const express = require('express');
const bodyParser = require('body-parser');
const PayOS = require('@payos/node');
// ================= 1. CẤU HÌNH =================
const CONFIG = {
    // Chỉ đọc từ môi trường, không có giá trị mặc định lộ liễu
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

    PAYOS_CLIENT_ID: process.env.PAYOS_CLIENT_ID,
    PAYOS_API_KEY: process.env.PAYOS_API_KEY,
    PAYOS_CHECKSUM_KEY: process.env.PAYOS_CHECKSUM_KEY,

    BANK: {
        ID: 'MB',       
        ACC: '0369455867', 
        NAME: 'NGUYEN DANG KHOA' 
    },
    PORT: process.env.PORT || 3000 
};

// ================= 2. KHỞI TẠO =================
const bot = new Telegraf(CONFIG.BOT_TOKEN);
const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.send('✅ Bot đang chạy ngon lành cành đào!');
});

// Khởi tạo PayOS
const payos = new PayOS(
    CONFIG.PAYOS_CLIENT_ID, 
    CONFIG.PAYOS_API_KEY, 
    CONFIG.PAYOS_CHECKSUM_KEY
);

// Bộ nhớ
const pendingOrders = new Map(); // Lưu đơn chờ thanh toán
const userInputState = new Map(); // [NEW] Lưu trạng thái người dùng đang nhập số lượng
let cachedProducts = [];

// Kết nối Sheet
const serviceAccountAuth = new JWT({
    email: CONFIG.GOOGLE_EMAIL,
    key: CONFIG.GOOGLE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(CONFIG.SHEET_ID, serviceAccountAuth);

// Mutex Lock
class Mutex {
    constructor() { this.queue = []; this.locked = false; }
    lock() {
        return new Promise(resolve => {
            if (this.locked) { this.queue.push(resolve); } 
            else { this.locked = true; resolve(); }
        });
    }
    unlock() {
        if (this.queue.length > 0) { const resolve = this.queue.shift(); resolve(); } 
        else { this.locked = false; }
    }
}
const stockMutex = new Mutex(); 

// ================= 3. LOGIC SHEET (CORE) =================
// (Giữ nguyên logic cũ)

// [MỚI] Hàm tạo mã đơn tự tăng (ord_bot_001, ord_bot_002...)
async function generateNextCustomID() {
    try {
        const sheet = doc.sheetsByTitle['LichSu'];
        const rows = await sheet.getRows();
        
        let maxId = 0;
        // Quét cột ma_don để tìm số lớn nhất hiện tại
        rows.forEach(row => {
            const code = row.get('ma_don');
            // Chỉ lấy các mã có dạng ord_bot_...
            if (code && code.startsWith('ord_bot_')) {
                // Tách số ra (Ví dụ: ord_bot_005 -> lấy số 5)
                const num = parseInt(code.replace('ord_bot_', ''));
                if (!isNaN(num) && num > maxId) {
                    maxId = num;
                }
            }
        });

        // Tăng thêm 1 và thêm số 0 vào trước (Padding)
        const nextId = maxId + 1;
        // .padStart(3, '0') nghĩa là đảm bảo luôn có 3 chữ số (001, 010, 100)
        return `ord_bot_${String(nextId).padStart(3, '0')}`;
    } catch (e) {
        console.error("Lỗi tạo ID mới:", e);
        return `ord_bot_ERROR_${Date.now()}`; // Fallback nếu lỗi
    }
}

async function fetchProducts() {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['MatHang'];
        if (!sheet) return [];
        const rows = await sheet.getRows();
        cachedProducts = rows.map(row => ({
            id: row.get('id'), name: row.get('ten_hang'), price: parseInt(row.get('gia').replace(/\D/g, ''))
        }));
        return cachedProducts;
    } catch (e) { return []; }
}

async function getStockCounts(products) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['KhoHang'];
        if (!sheet) return {};
        const rows = await sheet.getRows();
        const counts = {};
        products.forEach(p => counts[p.id] = 0);
        rows.forEach(row => {
            if (row.get('status') === 'chưa bán' && counts[row.get('loai_hang')] !== undefined) counts[row.get('loai_hang')]++;
        });
        return counts;
    } catch (e) { return {}; }
}

async function reserveStock(productId, quantity, orderId) {
    await stockMutex.lock();
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['KhoHang'];
        const rows = await sheet.getRows();
        const availableRows = rows.filter(row => row.get('loai_hang') === productId && row.get('status') === 'chưa bán');

        if (availableRows.length < quantity) {
            stockMutex.unlock();
            return { success: false, reason: `Chỉ còn ${availableRows.length} acc, không đủ ${quantity}.` };
        }

        const selectedRows = availableRows.slice(0, quantity);
        for (const row of selectedRows) {
            row.assign({ status: `dang_giu_${orderId}` });
            await row.save();
        }
        stockMutex.unlock();
        return { success: true };
    } catch (e) {
        stockMutex.unlock();
        return { success: false, reason: 'Lỗi hệ thống Sheet' };
    }
}

async function releaseStock(orderId) {
    await stockMutex.lock();
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['KhoHang'];
        const rows = await sheet.getRows();
        const rowsToRelease = rows.filter(row => row.get('status') === `dang_giu_${orderId}`);
        for (const row of rowsToRelease) {
            row.assign({ status: 'chưa bán' });
            await row.save();
        }
    } catch (e) {} finally { stockMutex.unlock(); }
}

async function finalizeStock(orderId) {
    await stockMutex.lock();
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['KhoHang'];
        const rows = await sheet.getRows();
        const rowsToFinalize = rows.filter(row => row.get('status') === `dang_giu_${orderId}`);
        if (rowsToFinalize.length === 0) {
             stockMutex.unlock();
             return { success: false, reason: 'Đơn hàng lỗi/hủy' };
        }
        const accounts = [];
        for (const row of rowsToFinalize) {
            accounts.push(`${row.get('username')} | ${row.get('password')}`);
            row.assign({ status: 'đã bán' }); 
            await row.save();
        }
        stockMutex.unlock();
        return { success: true, accounts };
    } catch (e) {
        stockMutex.unlock();
        return { success: false, reason: 'Lỗi xử lý kho' };
    }
}

// [CẬP NHẬT] Hàm ghi lịch sử lưu mã ord_bot_xxx
async function logHistory(user, pName, accounts) { // Bỏ tham số orderCode cũ đi
    await stockMutex.lock(); // Khóa lại để tránh 2 người cùng ra số 001
    try {
        // 1. Tạo mã mới
        const newCode = await generateNextCustomID();

        // 2. Lưu vào Sheet
        const sheet = doc.sheetsByTitle['LichSu'];
        const rows = accounts.map(acc => ({
            thoi_gian: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
            user_id: user.id, 
            username: user.username, 
            san_pham: pName, 
            tai_khoan_da_cap: acc,
            ma_don: newCode // <--- Lưu mã ord_bot_...
        }));
        await sheet.addRows(rows);
        
        stockMutex.unlock();
        return newCode; // Trả về mã mới để gửi cho khách xem
    } catch (e) {
        console.error("Lỗi ghi lịch sử:", e);
        stockMutex.unlock();
        return "Lỗi_Mã";
    }
}
// ================= 4. LOGIC XỬ LÝ MUA (DÙNG CHUNG) =================

async function handleBuyRequest(ctx, pid, qty) {
    const p = cachedProducts.find(x => x.id === pid);
    if (!p) return ctx.reply('Sản phẩm không hợp lệ.');

    // 1. TẠO MÃ ĐƠN (PayOS yêu cầu là số nguyên < 9007199254740991)
    // Dùng timestamp rút gọn để đảm bảo duy nhất và đủ ngắn
    const orderCode = Number(String(Date.now()).slice(-9));
    const orderIdString = String(orderCode); // Dạng chuỗi để lưu vào Google Sheet

    const msg = await ctx.reply(`⏳ Đang tạo link thanh toán cho ${qty} acc...`);

    // 2. GIỮ HÀNG TRÊN SHEET (Dùng ID chuỗi)
    const reserveResult = await reserveStock(pid, qty, orderIdString);

    if (!reserveResult.success) {
        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(()=>{});
        return ctx.reply(`⚠️ <b>Không thành công:</b> ${reserveResult.reason}`, { parse_mode: 'HTML' });
    }

    const total = p.price * qty;

    try {
        // 3. GỌI API PAYOS TẠO LINK
        const paymentData = {
            orderCode: orderCode,
            amount: total,
            description: `Thanh toan don ${orderCode}`,
            cancelUrl: "https://t.me", // Link khi khách bấm hủy
            returnUrl: "https://t.me"  // Link khi thành công
        };

        const paymentLinkRes = await payos.createPaymentLink(paymentData);
        
        // 4. LƯU ĐƠN VÀO RAM
        pendingOrders.set(orderCode, { // Lưu theo key là số (orderCode)
            userId: ctx.from.id,
            username: ctx.from.username,
            pid, pName: p.name, qty, total,
            created: Date.now(),
            orderIdString: orderIdString, // Lưu thêm ID dạng chuỗi để khớp với Sheet
            timer: null
        });

        // 5. HẸN GIỜ HỦY (15 phút)
        const timer = setTimeout(async () => {
            if (pendingOrders.has(orderCode)) {
                pendingOrders.delete(orderCode);
                await releaseStock(orderIdString);
                bot.telegram.sendMessage(ctx.from.id, `⏳ Đơn hàng ${orderCode} đã hủy do quá hạn.`);
            }
        }, 3 * 60 * 1000); 
        pendingOrders.get(orderCode).timer = timer;

        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(()=>{});

        // 6. GỬI TIN NHẮN (Link + QR Động)
        await ctx.replyWithPhoto(
            { url: `https://img.vietqr.io/image/${paymentLinkRes.bin}-${paymentLinkRes.accountNumber}-compact.png?amount=${total}&addInfo=${paymentLinkRes.description}&accountName=${paymentLinkRes.accountName}` }, 
            {
                caption: `🧾 <b>ĐƠN HÀNG: ${orderCode}</b>\n` +
                         `📦 ${p.name} (x${qty})\n` +
                         `💰 <b>${total.toLocaleString()}đ</b>\n\n` +
                         `💳 <b>THANH TOÁN:</b>\nQuét mã QR trên hoặc bấm nút bên dưới để mở cổng thanh toán.\n` +
                         `⚡ Hệ thống duyệt tự động ngay lập tức!\n` +
                         `⚠️ Lưu ý đơn hàng sẽ tự động hủy sau 3 phút nếu không thanh toán!`,
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 MỞ TRANG THANH TOÁN', paymentLinkRes.checkoutUrl)],
                    [Markup.button.callback('❌ Hủy đơn', `cancel_${orderCode}`)]
                ])
            }
        );

    } catch (error) {
        // --- IN LỖI CHI TIẾT RA MÀN HÌNH ĐEN (TERMINAL) ---
        console.error("❌ LỖI PAYOS CHI TIẾT:", error);
        
        // Nếu có response từ server PayOS thì in ra luôn
        if (error.response) {
            console.error("📦 Data lỗi từ PayOS:", error.response.data);
        }

        await releaseStock(orderIdString); // Hoàn kho
        ctx.reply("❌ Lỗi tạo thanh toán. Admin hãy xem cửa sổ console để biết lý do.");
    }
}

// ================= 5. BOT TELEGRAM =================

// ================= LOGIC HIỂN THỊ MENU (DÙNG CHUNG) =================
async function showMainMenu(ctx) {
    // 1. Xóa trạng thái đang nhập tay (nếu có) để tránh lỗi
    userInputState.delete(ctx.from.id);

    // 2. Lấy dữ liệu mới nhất từ Sheet
    const products = await fetchProducts();
    const stocks = await getStockCounts(products);
    
    // 3. Tạo lại danh sách nút với số lượng mới
    const buttons = products.map(p => {
        const stock = stocks ? (stocks[p.id] || 0) : 0;
        // Nếu hết hàng thì nút bấm sẽ dẫn đến 'out_of_stock', còn hàng thì 'view_ID'
        return [Markup.button.callback(
            `🔹 ${p.name} - ${p.price.toLocaleString()}đ (Còn: ${stock})`, 
            stock > 0 ? `view_${p.id}` : 'out_of_stock'
        )];
    });
    buttons.push([Markup.button.callback('🔄 Cập nhật kho', 'refresh')]);
    
    const menuText = `🛒 <b>SHOP MENU</b>\nChọn mặt hàng cần mua:\n` + 
                    `Mọi thắc mắc vui lòng liên hệ Zalo\n0346600098 hoặc 0369455867`;

    try {
        // Nếu là bấm nút (Action) -> Sửa tin nhắn cũ (Hiệu ứng load lại tại chỗ)
        if (ctx.callbackQuery) {
            await ctx.editMessageText(menuText, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard(buttons)
            });
        } 
        // Nếu là gõ lệnh /start -> Gửi tin nhắn mới
        else {
            await ctx.replyWithHTML(menuText, Markup.inlineKeyboard(buttons));
        }
    } catch (e) {
        // Nếu tin nhắn không có gì thay đổi (số lượng y nguyên) Telegram sẽ báo lỗi, ta bỏ qua
        if (ctx.callbackQuery) await ctx.answerCbQuery('Dữ liệu đã mới nhất!');
        else await ctx.replyWithHTML(menuText, Markup.inlineKeyboard(buttons));
    }
}

// ================= SỬ DỤNG HÀM TRÊN =================

// 1. Khi gõ /start
bot.start(async (ctx) => {
    await showMainMenu(ctx);
});

// 2. Khi bấm nút "Cập nhật kho"
bot.action('refresh', async (ctx) => {
    // Hiện thông báo nhỏ "Đang tải..."
    await ctx.answerCbQuery('⏳ Đang cập nhật số lượng...');
    // Gọi lại hàm menu để refresh số liệu
    await showMainMenu(ctx);
});

bot.action('out_of_stock', (ctx) => ctx.answerCbQuery('❌ Hết hàng!', { show_alert: true }));

// --- XEM HÀNG ---
bot.action(/view_(.+)/, async (ctx) => {
    const pid = ctx.match[1];
    const p = cachedProducts.find(x => x.id === pid);
    if (!p) return;

    const allStocks = await getStockCounts(cachedProducts);
    const currentStock = allStocks[p.id] || 0;

    if (currentStock === 0) return ctx.editMessageText('❌ Hết hàng.');

    const quantities = [1, 2, 5, 10]; 
    const buttons = [];
    const row = [];
    
    for (let q of quantities) {
        if (q <= currentStock) row.push(Markup.button.callback(`${q}`, `buy_${q}_${pid}`));
    }
    if (row.length > 0) buttons.push(row); // Hàng nút số lượng sẵn
    
    // [NEW] NÚT NHẬP TAY
    buttons.push([Markup.button.callback('✎ Nhập số lượng khác', `ask_qty_${pid}`)]);
    buttons.push([Markup.button.callback('🔙 Quay lại', 'refresh')]);

    await ctx.editMessageText(
        `📦 <b>${p.name}</b>\n💰 Giá: ${p.price.toLocaleString()}đ\n📊 Còn: <b>${currentStock}</b>\n\n👇 Chọn số lượng hoặc nhập tay:`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        }
    );
});

// --- XỬ LÝ MUA THEO NÚT CÓ SẴN ---
bot.action(/buy_(\d+)_(.+)/, async (ctx) => {
    const qty = parseInt(ctx.match[1]);
    const pid = ctx.match[2];
    userInputState.delete(ctx.from.id); // Xóa state nhập nếu có
    await handleBuyRequest(ctx, pid, qty);
});

// --- [NEW] XỬ LÝ BẤM NÚT NHẬP TAY ---
bot.action(/ask_qty_(.+)/, async (ctx) => {
    const pid = ctx.match[1];
    const p = cachedProducts.find(x => x.id === pid);
    
    // Lưu trạng thái: User này đang muốn mua SP này
    userInputState.set(ctx.from.id, { pid: pid, pName: p.name });

    await ctx.reply(`✎ Bạn muốn mua bao nhiêu acc <b>${p.name}</b>?\n(Vui lòng nhắn tin số lượng, ví dụ: 20)`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

// --- [NEW] LẮNG NGHE TIN NHẮN SỐ LƯỢNG ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    
    // 1. Kiểm tra xem user có đang ở chế độ nhập số lượng không
    if (!userInputState.has(userId)) return; // Nếu không thì bỏ qua (hoặc chat với bot bình thường)

    const state = userInputState.get(userId);
    const text = ctx.message.text;
    const qty = parseInt(text);

    // 2. Validate số lượng
    if (isNaN(qty) || qty <= 0) {
        return ctx.reply('❌ Vui lòng nhập số nguyên dương (Ví dụ: 5)');
    }

    // 3. Xóa trạng thái nhập để tránh spam
    userInputState.delete(userId);

    // 4. Gọi hàm mua hàng
    await handleBuyRequest(ctx, state.pid, qty);
});

// --- CÁC LOGIC KHÁC (Hủy, Duyệt, Paid...) ---
bot.action(/cancel_(.+)/, async (ctx) => {
    const orderCode = parseInt(ctx.match[1]);
    
    if (pendingOrders.has(orderCode)) {
        const order = pendingOrders.get(orderCode);
        clearTimeout(order.timer);
        pendingOrders.delete(orderCode);

        // Hoàn kho
        await releaseStock(order.orderIdString); 

        // Sửa dòng thông báo cũ
        try {
            await ctx.editMessageCaption(`❌ Đơn hàng ${orderCode} đã hủy.`);
        } catch (e) {}

        // [MỚI] Tự động load lại Menu cho khách mua món khác
        await ctx.reply('👇 Đã hủy đơn. Bạn muốn mua gì khác không?');
        await showMainMenu(ctx);
        
    } else {
        await ctx.answerCbQuery('Đơn không tồn tại hoặc đã bị hủy.');
        await showMainMenu(ctx); // Cũng quay về menu luôn cho tiện
    }
});

bot.action(/paid_(.+)/, (ctx) => {
    const orderId = ctx.match[1];
    if (!pendingOrders.has(orderId)) return ctx.reply('❌ Đơn hết hạn.');
    const order = pendingOrders.get(orderId);
    ctx.editMessageCaption('⏳ Đang chờ Admin...');
    
    // Gửi cho tất cả Admin
    CONFIG.ADMIN_ID.forEach(adminId => {
        bot.telegram.sendMessage(adminId, 
            `🔔 <b>KHÁCH BÁO PAID</b>\nUser: ${order.username}\nMã: ${orderId}\nTiền: ${order.total.toLocaleString()}đ`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Duyệt', `approve_${orderId}`), Markup.button.callback('❌ Hủy', `reject_${orderId}`)]]) }
        );
    });
});

// --- ADMIN DUYỆT ĐƠN ---
bot.action(/approve_(.+)/, async (ctx) => {
    // 1. Check quyền Admin
    if (!CONFIG.ADMIN_ID.includes(ctx.from.id)) return;
    
    const orderId = ctx.match[1];
    
    // 2. KIỂM TRA ĐƠN TRONG RAM
    const order = pendingOrders.get(orderId);
    if (!order) {
        return ctx.reply('⚠️ Lỗi: Đơn hàng không còn trong bộ nhớ đệm (RAM). Vui lòng xử lý thủ công.');
    }

    // Thông báo đang xử lý
    await ctx.editMessageText(`⏳ Đang xuất ${order.qty} acc... Vui lòng đợi!`);

    // 3. Tiến hành Chốt kho
    const result = await finalizeStock(orderId);

    if (result.success) {
        // 4. GỬI TÀI KHOẢN CHO KHÁCH + NÚT MUA TIẾP
        const accStr = result.accounts.map((a, i) => `${i+1}. ${a}`).join('\n');
        
        try {
            await bot.telegram.sendMessage(order.userId, 
                `🎉 <b>GIAO DỊCH THÀNH CÔNG!</b>\nAdmin đã duyệt đơn hàng của bạn.\n\n📦 <b>Tài khoản:</b>\n<pre>${accStr}</pre>`, 
                { 
                    parse_mode: 'HTML',
                    // 👇 THÊM NÚT Ở ĐÂY 👇
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🛍️ Thực hiện giao dịch khác', 'refresh')]
                    ])
                }
            );
            
            // 5. Dọn dẹp RAM và Log
            clearTimeout(order.timer);
            pendingOrders.delete(orderId);
            logHistory({ id: order.userId, username: order.username }, order.pName, result.accounts, orderId);
            
            // Báo lại cho Admin
            return ctx.editMessageText(`✅ Đã gửi xong ${order.qty} acc cho khách!`);
            
        } catch (err) {
            return ctx.reply(`⚠️ Đã chốt kho nhưng LỖI GỬI TIN CHO KHÁCH: ${err.message}`);
        }
    } else {
        return ctx.reply(`❌ Lỗi cập nhật Sheet: ${result.reason}`);
    }
});

// --- ADMIN TỪ CHỐI ĐƠN (Thêm vào nếu bị thiếu) ---
bot.action(/reject_(.+)/, async (ctx) => {
    // Check quyền
    if (!CONFIG.ADMIN_ID.includes(ctx.from.id)) return;

    const orderId = ctx.match[1];
    const order = pendingOrders.get(orderId);
    
    if (order) {
        clearTimeout(order.timer);
        await releaseStock(order.orderIdString); // Hoàn kho
        
        // Báo khách
        bot.telegram.sendMessage(order.userId, `❌ Đơn hàng ${orderId} của bạn đã bị Admin từ chối. Vui lòng liên hệ hỗ trợ.`);
        
        // Xóa RAM
        pendingOrders.delete(orderId);
    }
    ctx.editMessageText(`❌ Đã TỪ CHỐI đơn ${orderId}. Hàng đã hoàn về kho.`);
});

// --- LỆNH ADMIN: DỌN DẸP ĐƠN TREO THỦ CÔNG ---
// Chỉ Admin mới dùng được lệnh này. Gõ: /fix
// --- LỆNH ADMIN: DỌN DẸP ĐƠN TREO THỦ CÔNG ---
// Chỉ Admin mới dùng được lệnh này. Gõ: /fix
bot.command('fix', async (ctx) => {
    // 1. Check quyền Admin (Dùng danh sách ID)
    // Lưu ý: Đảm bảo CONFIG.ADMIN_ID trong bot.js là mảng [id1, id2]
    const adminIds = Array.isArray(CONFIG.ADMIN_ID) ? CONFIG.ADMIN_ID : [CONFIG.ADMIN_ID];
    
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('⛔ Bạn không có quyền Admin.');

    const msg = await ctx.reply('🧹 Đang quét dọn các đơn hàng bị treo (dang_giu)...');
    
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['KhoHang'];
        const rows = await sheet.getRows();
        
        let count = 0;
        let updates = [];

        // Duyệt qua tất cả dòng
        for (const row of rows) {
            const status = row.get('status');
            // Tìm những dòng đang giữ mà không phải do đơn hàng đang chạy
            if (status && status.startsWith('dang_giu_')) {
                const orderCode = status.replace('dang_giu_', '');
                
                // Nếu đơn này KHÔNG còn trong bộ nhớ Bot (nghĩa là Bot đã quên nó rồi) -> Reset
                // Kiểm tra cả dạng số và chuỗi cho chắc ăn
                if (!pendingOrders.has(parseInt(orderCode)) && !pendingOrders.has(orderCode)) {
                    row.assign({ status: 'chưa bán' });
                    updates.push(row.save()); 
                    count++;
                }
            }
        }
        
        if (count > 0) {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `⏳ Phát hiện ${count} acc bị treo. Đang phục hồi...`);
            
            // Chạy lần lượt để tránh crash do Google chặn (Rate Limit)
            for (const p of updates) {
                await p; 
                await new Promise(r => setTimeout(r, 200)); // Nghỉ 0.2s
            }
            
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Đã giải cứu thành công <b>${count}</b> acc về kho!`, { parse_mode: 'HTML' });
        } else {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '👍 Kho sạch sẽ, không có đơn nào bị treo.');
        }
        
    } catch (e) {
        console.error(e);
        await ctx.reply(`❌ Lỗi dọn dẹp: ${e.message}`);
    }
});

// ================= 5. WEBHOOK =================

app.post('/webhook', async (req, res) => {
    console.log("🔔 Webhook PayOS received!");
    
    // In ra xem PayOS gửi cái gì (Debug)
    // console.log("RAW BODY:", JSON.stringify(req.body, null, 2));

    try {
        // 1. Xác thực dữ liệu
        const webhookData = payos.verifyPaymentWebhookData(req.body);
        
        // In ra dữ liệu sau khi xác thực
        console.log("VERIFIED DATA:", webhookData);

        // 2. TỰ ĐỘNG DÒ TÌM DỮ LIỆU (FIX LỖI QUAN TRỌNG)
        // Bản v1.0.8 có thể trả về data trực tiếp, hoặc gói trong .data
        // Ta dùng toán tử || để bắt cả 2 trường hợp
        const dataObj = webhookData.data || webhookData; 

        // Nếu không tìm thấy object chứa dữ liệu -> Báo lỗi
        if (!dataObj) {
            console.log("❌ Không tìm thấy dữ liệu trong Webhook");
            return res.json({ success: false });
        }

        // Lấy thông tin đơn hàng
        const orderCode = dataObj.orderCode; 
        const amount = dataObj.amount;
        const code = webhookData.code || "00"; // Mặc định là thành công nếu đã qua bước verify

        console.log(`🔎 Đang tìm đơn: ${orderCode} - Tiền: ${amount}`);

        // 3. Xử lý giao dịch thành công
        if (code === "00" && orderCode) {
            
            // Tìm đơn trong RAM
            if (pendingOrders.has(orderCode)) {
                const order = pendingOrders.get(orderCode);
                
                console.log(`✅ Tìm thấy đơn hàng trong RAM: ${orderCode}`);

                // Kiểm tra số tiền
                if (amount >= order.total) {
                    clearTimeout(order.timer);

                    // Chốt đơn
                    const result = await finalizeStock(order.orderIdString);

                    if (result.success) {
                        const accStr = result.accounts.map((a, i) => `${i+1}. ${a}`).join('\n');
                    
                        const finalCode = await logHistory({ id: order.userId, username: order.username }, order.pName, result.accounts);

                        await bot.telegram.sendMessage(order.userId, 
                            `✅ <b>THANH TOÁN THÀNH CÔNG!</b>\n` +
                            `Mã đơn: <b>${finalCode}</b>\n` + // <--- Hiện mã ord_bot_xxx
                            `Đã nhận: ${amount.toLocaleString()}đ\n\n` +
                            `📦 <b>Tài khoản của bạn:</b>\n<pre>${accStr}</pre>`, 
                            { 
                                parse_mode: 'HTML',
                                ...Markup.inlineKeyboard([[Markup.button.callback('🛍️ Mua tiếp', 'refresh')]])
                            }
                        );
                        
                        // Báo Admin cũng dùng mã mới cho dễ đối soát
                        CONFIG.ADMIN_ID.forEach(id => {
                            bot.telegram.sendMessage(id, `🤖 Đơn mới: ${finalCode} (PayOS ID: ${orderCode}) OK.`).catch(()=>{});
                        });
                        pendingOrders.delete(orderCode);
                        console.log("🎉 Đã trả hàng xong!");
                    } else {
                        console.error("❌ Lỗi chốt kho:", result.reason);
                    }
                } else {
                    console.log("⚠️ Số tiền không đủ:", amount, "<", order.total);
                }
            } else {
                console.log("⚠️ Không tìm thấy đơn hàng trong RAM (Có thể đã quá hạn hoặc khởi động lại Bot).");
                // Mẹo: Nếu bạn muốn xử lý cả đơn bị mất RAM (do tắt bot), cần lưu đơn vào file hoặc DB.
                // Ở đây ta tạm thời bỏ qua.
            }
        }

        res.json({ success: true });

    } catch (e) {
        console.error('❌ Lỗi xử lý Webhook:', e.message);
        console.error(e);
        res.json({ success: false });
    }
});

bot.launch();
app.listen(CONFIG.PORT, () => console.log(`🚀 Running on ${CONFIG.PORT}`));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));