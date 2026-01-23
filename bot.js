/**
 * SHOP BOT V7 - ORD_BOT_PAYOS ID
 * Tính năng: Mã đơn hàng đồng bộ (ORD_BOT_xxx), lưu vào Stock & History.
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const express = require('express');
const bodyParser = require('body-parser');
const PayOS = require('@payos/node');
const { authenticator } = require('otplib'); // <--- Thêm dòng này

// ================= 1. CẤU HÌNH =================
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN, 
    SHEET_ID: process.env.SHEET_ID,
    GOOGLE_EMAIL: process.env.GOOGLE_EMAIL,
    GOOGLE_KEY: process.env.GOOGLE_KEY ? process.env.GOOGLE_KEY.replace(/\\n/g, '\n') : '',
    
    ADMIN_ID: [ 
        parseInt(process.env.ADMIN_ID_1), 
        parseInt(process.env.ADMIN_ID_2) 
    ].filter(Boolean),

    PAYOS_CLIENT_ID: process.env.PAYOS_CLIENT_ID,
    PAYOS_API_KEY: process.env.PAYOS_API_KEY,
    PAYOS_CHECKSUM_KEY: process.env.PAYOS_CHECKSUM_KEY,
    
    PORT: process.env.PORT || 3000 
};

// ================= 2. KHỞI TẠO =================
const bot = new Telegraf(CONFIG.BOT_TOKEN);
const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => res.send('✅ Shop Bot Online!'));

const payos = new PayOS(CONFIG.PAYOS_CLIENT_ID, CONFIG.PAYOS_API_KEY, CONFIG.PAYOS_CHECKSUM_KEY);

const pendingOrders = new Map(); 
const userInputState = new Map(); 
let cachedProducts = []; 

const serviceAccountAuth = new JWT({
    email: CONFIG.GOOGLE_EMAIL,
    key: CONFIG.GOOGLE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(CONFIG.SHEET_ID, serviceAccountAuth);

class Mutex {
    constructor() { this.queue = []; this.locked = false; }
    lock() { return new Promise(resolve => { if (this.locked) { this.queue.push(resolve); } else { this.locked = true; resolve(); } }); }
    unlock() { if (this.queue.length > 0) { const resolve = this.queue.shift(); resolve(); } else { this.locked = false; } }
}
const stockMutex = new Mutex(); 

// ================= 3. LOGIC SHEET =================

async function fetchProducts() {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Products'];
        const rows = await sheet.getRows();
        cachedProducts = rows.map(row => ({
            id: row.get('id'), 
            name: row.get('name'), 
            price: parseInt(row.get('price').replace(/\D/g, ''))
        }));
        return cachedProducts;
    } catch (e) { return []; }
}

async function getStockCounts(products) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Stock'];
        const rows = await sheet.getRows();
        const counts = {};
        products.forEach(p => counts[p.id] = 0);
        rows.forEach(row => {
            if (row.get('status') === 'available' && counts[row.get('product_id')] !== undefined) {
                counts[row.get('product_id')]++;
            }
        });
        return counts;
    } catch (e) { return {}; }
}

async function reserveStock(productId, quantity, tempOrderId) {
    await stockMutex.lock();
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Stock'];
        const rows = await sheet.getRows();
        const availableRows = rows.filter(row => row.get('product_id') === productId && row.get('status') === 'available');

        if (availableRows.length < quantity) {
            stockMutex.unlock();
            return { success: false, reason: `Kho chỉ còn ${availableRows.length}, không đủ.` };
        }

        for (let i = 0; i < quantity; i++) {
            availableRows[i].assign({ status: `holding_${tempOrderId}` });
            await availableRows[i].save();
        }
        stockMutex.unlock();
        return { success: true };
    } catch (e) {
        stockMutex.unlock();
        return { success: false, reason: 'Lỗi Sheet' };
    }
}

async function releaseStock(tempOrderId) {
    await stockMutex.lock();
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Stock'];
        const rows = await sheet.getRows();
        const rowsToRelease = rows.filter(row => row.get('status') === `holding_${tempOrderId}`);
        for (const row of rowsToRelease) {
            row.assign({ status: 'available' });
            await row.save();
        }
    } catch (e) {} finally { stockMutex.unlock(); }
}

// [CẬP NHẬT] HÀM CHỐT ĐƠN (Hỗ trợ cột 2fa tùy chọn + Price)
async function finalizeStock(tempOrderId, userInfo, pName, payOSCode, productPrice) {
    await stockMutex.lock();
    try {
        await doc.loadInfo();
        
        // 1. Tạo mã đơn hàng
        const finalOrderId = `ORD_BOT_${payOSCode}`; 
        
        // 2. Cập nhật sheet Stock
        const sheetStock = doc.sheetsByTitle['Stock'];
        const rowsStock = await sheetStock.getRows();
        const rowsToFinalize = rowsStock.filter(row => row.get('status') === `holding_${tempOrderId}`);
        
        if (rowsToFinalize.length === 0) {
             stockMutex.unlock();
             return { success: false, reason: 'Đơn hàng lỗi/hủy' };
        }

        const accounts = [];
        for (const row of rowsToFinalize) {
            // --- LOGIC XỬ LÝ 2FA TÙY CHỌN ---
            const user = row.get('username');
            const pass = row.get('password');
            const twofa = row.get('2fa'); // Lấy giá trị cột 2fa

            let accString = `${user} | ${pass}`;
            
            // Kiểm tra: nếu cột 2fa có dữ liệu (không null, không rỗng) thì nối thêm vào
            if (twofa && String(twofa).trim() !== '') {
                accString += ` | ${twofa}`;
            }
            // ---------------------------------

            accounts.push(accString);
            
            // Update trạng thái và mã đơn vào Stock
            row.assign({ 
                status: 'sold',
                order_id: finalOrderId 
            }); 
            await row.save();
        }

        // 3. Ghi vào sheet History
        const sheetHistory = doc.sheetsByTitle['History'];
        const historyRows = accounts.map(acc => ({
            date: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
            user_id: userInfo.id, 
            username: userInfo.username, 
            product_name: pName, 
            account: acc, // acc lúc này đã tự động có hoặc không có 2fa tùy theo logic trên
            order_id: finalOrderId,
            price: productPrice
        }));
        await sheetHistory.addRows(historyRows);

        stockMutex.unlock();
        return { success: true, accounts, finalOrderId };
    } catch (e) {
        stockMutex.unlock();
        console.error(e);
        return { success: false, reason: 'Lỗi cập nhật kho' };
    }
}

// get customer phone number
async function updatePhoneHistory(orderId, phoneNumber) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['History'];
        const rows = await sheet.getRows();
        
        // Tìm tất cả các dòng có mã đơn hàng này (vì 1 đơn có thể mua nhiều acc)
        const orderRows = rows.filter(row => row.get('order_id') === orderId);
        
        if (orderRows.length === 0) return false;

        for (const row of orderRows) {
            // 'phone' là tên cột bạn vừa tạo ở Bước 1
            row.assign({ phone: phoneNumber }); 
            await row.save();
        }
        return true;
    } catch (e) {
        console.error("Lỗi update SĐT:", e);
        return false;
    }
}

// ================= 4. MUA HÀNG =================

async function handleBuyRequest(ctx, pid, qty) {
    const p = cachedProducts.find(x => x.id === pid);
    if (!p) return ctx.reply('❌ Sản phẩm không hợp lệ.');

    const tempOrderId = String(Date.now()); 
    const payOSOrderCode = Number(tempOrderId.slice(-9)); 

    const msg = await ctx.reply(`⏳ Đang tạo link thanh toán...`);

    const reserveResult = await reserveStock(pid, qty, tempOrderId);
    if (!reserveResult.success) {
        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(()=>{});
        return ctx.reply(`⚠️ ${reserveResult.reason}`);
    }

    const total = p.price * qty;

    try {
        const paymentLinkRes = await payos.createPaymentLink({
            orderCode: payOSOrderCode,
            amount: total,
            description: `Thanh toan ${payOSOrderCode}`,
            cancelUrl: "https://t.me", 
            returnUrl: "https://t.me"
        });
        
        pendingOrders.set(payOSOrderCode, { 
            userId: ctx.from.id,
            username: ctx.from.username,
            pid, pName: p.name, 
            price: p.price,
            qty, total,
            tempOrderId: tempOrderId,
            timer: setTimeout(async () => {
                if (pendingOrders.has(payOSOrderCode)) {
                    pendingOrders.delete(payOSOrderCode);
                    await releaseStock(tempOrderId);
                    bot.telegram.sendMessage(ctx.from.id, `⏳ Đơn ${payOSOrderCode} đã hủy do quá hạn.`);
                }
            }, 5 * 60 * 1000) 
        });

        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(()=>{});
        await ctx.replyWithPhoto(
            { url: `https://img.vietqr.io/image/${paymentLinkRes.bin}-${paymentLinkRes.accountNumber}-compact.png?amount=${total}&addInfo=${paymentLinkRes.description}&accountName=${paymentLinkRes.accountName}` }, 
            {
                caption: `🧾 <b>ĐƠN HÀNG: ${payOSOrderCode}</b>\n📦 ${p.name} (x${qty})\n💰 <b>${total.toLocaleString()}đ</b>`,
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 APP NGÂN HÀNG', paymentLinkRes.checkoutUrl)],
                    [Markup.button.callback('❌ Hủy đơn', `cancel_${payOSOrderCode}`)]
                ])
            }
        );

    } catch (error) {
        await releaseStock(tempOrderId);
        ctx.reply("❌ Lỗi tạo thanh toán.");
    }
}

// ================= 5. UI =================

async function showMainMenu(ctx) {
    userInputState.delete(ctx.from.id);
    const products = await fetchProducts();
    const stocks = await getStockCounts(products);
    
    const buttons = products.map(p => {
        const stock = stocks ? (stocks[p.id] || 0) : 0;
        return [Markup.button.callback(`🔹 ${p.name} - ${p.price.toLocaleString()}đ (Còn: ${stock})`, stock > 0 ? `view_${p.id}` : 'out_of_stock')];
    });
    buttons.push([Markup.button.callback('🔄 Cập nhật kho', 'refresh')]);
    
    const menuText = `🛒 <b>SHOP MENU</b>`;
    try {
        if (ctx.callbackQuery) await ctx.editMessageText(menuText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        else await ctx.replyWithHTML(menuText, Markup.inlineKeyboard(buttons));
    } catch (e) {
        if(ctx.callbackQuery) ctx.answerCbQuery();
    }
}

bot.start(async (ctx) => {
    // Hiện nút bấm "cứng" (Reply Keyboard)
    await ctx.reply('👋 Chào mừng bạn quay lại!', 
        Markup.keyboard([
            ['🛒 Mở Menu Mua Hàng', '🔐 Lấy mã 2FA'] // <--- Thêm nút 2FA vào đây
        ])
        .resize()
    );
    
    // Hiện menu mua hàng (nếu muốn) hoặc chỉ hiện lời chào
    // await showMainMenu(ctx); (Tùy bạn có muốn hiện luôn menu mua hàng không)
});
bot.action('refresh', showMainMenu);
bot.action('out_of_stock', (ctx) => ctx.answerCbQuery('❌ Hết hàng!', { show_alert: true }));

bot.action(/view_(.+)/, async (ctx) => {
    const pid = ctx.match[1];
    const p = cachedProducts.find(x => x.id === pid);
    if (!p) return ctx.reply('❌ Lỗi SP');
    
    const allStocks = await getStockCounts(cachedProducts);
    const currentStock = allStocks[p.id] || 0;
    
    if (currentStock === 0) return ctx.editMessageText('❌ Hết hàng.');

    const quantities = [1, 2, 5, 10]; 
    const buttons = [];
    const row = [];
    for (let q of quantities) { if (q <= currentStock) row.push(Markup.button.callback(`${q}`, `buy_${q}_${pid}`)); }
    if (row.length > 0) buttons.push(row);
    
    buttons.push([Markup.button.callback('✎ Nhập số lượng khác', `ask_qty_${pid}`)]);
    buttons.push([Markup.button.callback('🔙 Quay lại', 'refresh')]);

    await ctx.editMessageText(`📦 <b>${p.name}</b>\n💰 Giá: ${p.price.toLocaleString()}đ\n📊 Còn: <b>${currentStock}</b>`, 
        { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
    );
});

bot.action(/buy_(\d+)_(.+)/, async (ctx) => {
    userInputState.delete(ctx.from.id);
    await handleBuyRequest(ctx, ctx.match[2], parseInt(ctx.match[1]));
});

bot.action(/ask_qty_(.+)/, async (ctx) => {
    const pid = ctx.match[1];
    const p = cachedProducts.find(x => x.id === pid);
    userInputState.set(ctx.from.id, { pid: pid, pName: p.name });
    await ctx.reply(`✎ Nhập số lượng mua <b>${p.name}</b>:`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('skip_save_phone', async (ctx) => {
    const userId = ctx.from.id;
    if (userInputState.has(userId)) {
        userInputState.delete(userId); // Xóa trạng thái chờ
        
        // [CẬP NHẬT] Thêm nút "Tiếp tục mua hàng" (callback là 'refresh' để gọi lại menu)
        await ctx.editMessageText(
            '✅ Đã bỏ qua bước lưu số điện thoại. Bạn có thể tiếp tục mua sắm!',
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🛍️ Tiếp tục mua hàng', 'refresh')]
                ])
            }
        );
    } else {
        await ctx.answerCbQuery('Bạn không ở trạng thái chờ nhập SĐT.');
    }
});

// ================= XỬ LÝ NHẬP LIỆU (SỐ LƯỢNG MUA HOẶC SỐ ĐIỆN THOẠI) =================
// ================= XỬ LÝ TIN NHẮN VĂN BẢN (TEXT) =================
// [THÊM MỚI] Bắt sự kiện khi khách bấm nút "Menu Mua Hàng" ở góc dưới
bot.hears('🛒 Mở Menu Mua Hàng', async (ctx) => {
    // Xóa các trạng thái nhập liệu cũ (nếu có) để tránh bị kẹt
    userInputState.delete(ctx.from.id); 
    
    // Hiện lại menu
    await showMainMenu(ctx);
});
// --- LOGIC XỬ LÝ NÚT 2FA ---
bot.hears('🔐 Lấy mã 2FA', async (ctx) => {
    // 1. Đặt trạng thái chờ nhập Key
    userInputState.set(ctx.from.id, { action: 'CONVERT_2FA' });
    
    // 2. Hướng dẫn người dùng
    await ctx.reply(
        '🔐 <b>CHUYỂN ĐỔI MÃ 2FA</b>\n\n' +
        'Vui lòng gửi <b>Mã bảo mật (Secret Key)</b> của bạn vào đây.\n' +
        '(Ví dụ: <code>JBSWY3DPEHPK3PXP</code>)\n\n' +
        '👉 Gõ <b>"hủy"</b> để quay lại.',
        { parse_mode: 'HTML' }
    );
});
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();

    // Nếu user không có trong danh sách đợi (không đang mua, không đang chờ nhập SĐT) thì bỏ qua
    if (!userInputState.has(userId)) return;
    
    const state = userInputState.get(userId);

    // ================= [THÊM MỚI] XỬ LÝ 2FA =================
    if (state.action === 'CONVERT_2FA') {
        // Cho phép hủy
        if (['hủy', 'huy', 'thoát', 'menu'].includes(text.toLowerCase())) {
            userInputState.delete(userId);
            return ctx.reply('✅ Đã thoát chế độ 2FA.', Markup.keyboard([['🛒 Mở Menu Mua Hàng', '🔐 Lấy mã 2FA']]).resize());
        }

        try {
            // 1. Làm sạch key (Xóa khoảng trắng, viết hoa)
            const secret = text.replace(/\s/g, '').toUpperCase();

            // 2. Tính toán mã 2FA (6 số)
            const token = authenticator.generate(secret);
            
            // 3. Tính thời gian còn lại của mã (Mã đổi mỗi 30s)
            const timeRemaining = authenticator.timeRemaining();

            // 4. Trả kết quả (Để trong thẻ code để user ấn vào là copy)
            await ctx.reply(
                `🔑 Mã 2FA của bạn:\n` +
                `<code>${token}</code>\n\n` +
                `⏳ Còn hiệu lực: ${timeRemaining}s\n` +
                `👇 Gửi key khác hoặc gõ "hủy" để thoát.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            ctx.reply('❌ Mã Key không hợp lệ! Vui lòng kiểm tra lại.\n(Key thường là chuỗi chữ và số ngẫu nhiên).');
        }
        return; // Dừng xử lý tại đây
    }
    // ================= KẾT THÚC ĐOẠN 2FA =================

    // --- TRƯỜNG HỢP 1: ĐANG CHỜ NHẬP SỐ ĐIỆN THOẠI (BẢO HÀNH) ---
    if (state.action === 'wf_phone') {
        
        // 1. Cho phép thoát bằng lệnh hoặc từ khóa
        if (text.startsWith('/') || ['hủy', 'huy', 'bỏ qua', 'bo qua', 'skip'].includes(text.toLowerCase())) {
            if (state.timer) clearTimeout(state.timer); 
            userInputState.delete(userId);
            
            // [CẬP NHẬT] Trả lời kèm nút bấm
            return ctx.reply(
                '✅ Đã hủy bước nhập số điện thoại.',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🛍️ Tiếp tục mua hàng', 'refresh')]
                ])
            );
        }

        // 2. Kiểm tra định dạng số điện thoại (VN)
        if (!/^(0|\+84)\d{9,10}$/.test(text)) {
            return ctx.reply('⚠️ Số điện thoại không hợp lệ.\n👉 Vui lòng nhập lại (VD: 0912345678) hoặc gõ <b>"hủy"</b> để bỏ qua.', { parse_mode: 'HTML' });
        }

        // 3. Tiến hành lưu vào Google Sheet
        const msg = await ctx.reply('⏳ Đang lưu thông tin...');
        
        // Gọi hàm updatePhoneHistory (bạn nhớ phải thêm hàm này vào file rồi nhé)
        const success = await updatePhoneHistory(state.orderId, text);
        
        if (success) {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, 
                `✅ <b>Đã lưu số điện thoại: ${text}</b>\nCảm ơn bạn! Bảo hành cho đơn hàng đã được kích hoạt.`,
                { parse_mode: 'HTML' }
            );
            
            // [QUAN TRỌNG] Hủy hẹn giờ timeout vì họ đã nhập xong rồi
            if (state.timer) clearTimeout(state.timer); 

            // Xóa trạng thái để user chat bình thường
            userInputState.delete(userId);
        } else {
            ctx.reply('❌ Có lỗi khi lưu dữ liệu. Vui lòng thử lại sau hoặc liên hệ Admin.');
        }
        return; // Kết thúc xử lý tại đây
    }

    // --- TRƯỜNG HỢP 2: ĐANG CHỜ NHẬP SỐ LƯỢNG MUA HÀNG (LOGIC CŨ) ---
    // Kiểm tra nếu state có chứa pid (tức là đang mua sản phẩm)
    if (state.pid) {
        const qty = parseInt(text);
        if (isNaN(qty) || qty <= 0) return ctx.reply('❌ Số lượng không hợp lệ. Vui lòng nhập số lớn hơn 0.');
        
        userInputState.delete(userId); // Xóa trạng thái mua hàng
        await handleBuyRequest(ctx, state.pid, qty);
    }
});

bot.action(/cancel_(.+)/, async (ctx) => {
    const code = parseInt(ctx.match[1]);
    if(pendingOrders.has(code)) {
        const order = pendingOrders.get(code);
        clearTimeout(order.timer);
        await releaseStock(order.tempOrderId);
        pendingOrders.delete(code);
        await ctx.editMessageCaption(`❌ Đơn ${code} đã hủy.`);
        await showMainMenu(ctx);
    } else {
        ctx.answerCbQuery('Đơn không tồn tại.');
        showMainMenu(ctx);
    }
});

// ADMIN FIX
bot.command('fix', async (ctx) => {
    if (!CONFIG.ADMIN_ID.includes(ctx.from.id)) return ctx.reply('⛔ No Admin');
    const msg = await ctx.reply('🧹 Scanning...');
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Stock'];
        const rows = await sheet.getRows();
        let count = 0;
        let updates = [];
        for (const row of rows) {
            const status = row.get('status');
            if (status && status.startsWith('holding_')) {
                const tempId = status.replace('holding_', '');
                let isActive = false;
                for (let [key, val] of pendingOrders) {
                    if (val.tempOrderId === tempId) { isActive = true; break; }
                }
                if (!isActive) {
                    row.assign({ status: 'available' });
                    updates.push(row.save()); 
                    count++;
                }
            }
        }
        if (count > 0) {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `⏳ Fixing ${count}...`);
            for (const p of updates) { await p; await new Promise(r => setTimeout(r, 200)); }
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Released ${count} items!`);
        } else {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '👍 Clean.');
        }
    } catch (e) {
        ctx.reply(`❌ Error: ${e.message}`);
    }
});

// WEBHOOK
app.post('/webhook', async (req, res) => {
    try {
        const webhookData = payos.verifyPaymentWebhookData(req.body);
        const dataObj = webhookData.data || webhookData; 
        const orderCode = dataObj.orderCode; 
        const amount = dataObj.amount;

        if (webhookData.code === "00" && pendingOrders.has(orderCode)) {
            const order = pendingOrders.get(orderCode);
            
            if (amount >= order.total) {
                clearTimeout(order.timer);

                // Truyền orderCode (mã PayOS) vào để làm đuôi cho mã ORD_BOT_
                const result = await finalizeStock(
                    order.tempOrderId, 
                    { id: order.userId, username: order.username }, 
                    order.pName,
                    orderCode,
                    order.price
                );

                if (result.success) {
                    const accStr = result.accounts.map((a, i) => `${i+1}. ${a}`).join('\n');
                    
                    // [LOGIC MỚI] Kiểm tra xem có 2FA không để tạo tiêu đề
                    // Nếu dòng acc có nhiều hơn 2 phần tử cách nhau bởi dấu "|" thì tức là có 2FA
                    // (VD: "User | Pass" -> length là 2. "User | Pass | 2FA" -> length là 3)
                    const has2FA = result.accounts.length > 0 && result.accounts[0].split('|').length > 2;
                    
                    // Tạo dòng tiêu đề tương ứng
                    const headerTitle = has2FA ? "Username | Password | 2FA" : "Username | Password";

                    // 1. Gửi thông tin tài khoản (Acc) cho khách KÈM TIÊU ĐỀ
                    await bot.telegram.sendMessage(order.userId, 
                        `✅ <b>THANH TOÁN THÀNH CÔNG!</b>\n` +
                        `Mã đơn: <b>${result.finalOrderId}</b>\n` +
                        `📦 <b>Tài khoản của bạn:</b>\n` +
                        `<code>${headerTitle}</code>\n` + // <--- Dòng tiêu đề thêm vào ở đây
                        `<pre>${accStr}</pre>`, 
                        { parse_mode: 'HTML' }
                    );

                    // 2. Gửi yêu cầu nhập SĐT + Nút "Bỏ qua"
                    await bot.telegram.sendMessage(order.userId, 
                        `🛡 <b>KÍCH HOẠT BẢO HÀNH</b>\n\n` +
                        `Vui lòng nhập <b>SỐ ĐIỆN THOẠI</b> để hệ thống lưu bảo hành.\n` +
                        `Hoặc bấm nút bên dưới nếu bạn không muốn lưu.`,
                        { 
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback('❌ Bỏ qua (Không lưu)', 'skip_save_phone')]
                            ])
                        }
                    );
                    
                    // 3. Tạo bộ đếm: Sau 10 phút nếu không nhập thì tự hủy trạng thái chờ
                    const timeoutJob = setTimeout(async () => {
                        // Kiểm tra xem sau 10p user có còn đang ở trạng thái chờ không
                        if (userInputState.has(order.userId)) {
                            const currentState = userInputState.get(order.userId);
                            if (currentState.action === 'wf_phone') {
                                userInputState.delete(order.userId);
                                try {
                                    await bot.telegram.sendMessage(order.userId, 
                                        '⏳ Đã hết thời gian chờ nhập SĐT bảo hành. Bạn có thể liên hệ Admin nếu cần bổ sung sau.'
                                    );
                                } catch (e) {}
                            }
                        }
                    }, 10 * 60 * 1000); // 10 phút

                    // 4. Lưu trạng thái chờ nhập SĐT + kèm theo cái hẹn giờ (timer)
                    userInputState.set(order.userId, { 
                        action: 'wf_phone', 
                        orderId: result.finalOrderId,
                        timer: timeoutJob 
                    });
                    
                    // 5. Báo Admin có đơn mới
                    CONFIG.ADMIN_ID.forEach(id => {
                        bot.telegram.sendMessage(id, `💰 Đơn mới: ${result.finalOrderId} (${order.total.toLocaleString()}đ)`).catch(()=>{});
                    });
                    
                    // 6. Xóa đơn hàng khỏi danh sách chờ thanh toán
                    pendingOrders.delete(orderCode);
                }
                // --- KẾT THÚC ĐOẠN CODE THAY THẾ ---
            }
        }
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.json({ success: false });
    }
});

bot.launch();
app.listen(CONFIG.PORT, () => console.log(`🚀 Running`));