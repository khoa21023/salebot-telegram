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

// [QUAN TRỌNG] HÀM CHỐT ĐƠN MỚI
async function finalizeStock(tempOrderId, userInfo, pName, payOSCode) {
    await stockMutex.lock();
    try {
        await doc.loadInfo();
        
        // 1. Tạo mã đơn hàng theo định dạng yêu cầu
        const finalOrderId = `ORD_BOT_${payOSCode}`; 
        
        // 2. Cập nhật sheet Stock (Ghi thêm order_id)
        const sheetStock = doc.sheetsByTitle['Stock'];
        const rowsStock = await sheetStock.getRows();
        const rowsToFinalize = rowsStock.filter(row => row.get('status') === `holding_${tempOrderId}`);
        
        if (rowsToFinalize.length === 0) {
             stockMutex.unlock();
             return { success: false, reason: 'Đơn hàng lỗi/hủy' };
        }

        const accounts = [];
        for (const row of rowsToFinalize) {
            accounts.push(`${row.get('username')} | ${row.get('password')}`);
            // Update cả status và order_id
            row.assign({ 
                status: 'sold',
                order_id: finalOrderId // <--- Ghi mã đơn vào Stock
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
            account: acc,
            order_id: finalOrderId // <--- Ghi mã đơn vào History
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

bot.start(showMainMenu);
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

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    if (!userInputState.has(userId)) return;
    const state = userInputState.get(userId);
    const qty = parseInt(ctx.message.text);
    if (isNaN(qty) || qty <= 0) return ctx.reply('❌ Số lượng sai');
    userInputState.delete(userId);
    await handleBuyRequest(ctx, state.pid, qty);
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
                    orderCode // <--- Mã số PayOS
                );

                if (result.success) {
                    const accStr = result.accounts.map((a, i) => `${i+1}. ${a}`).join('\n');
                    
                    await bot.telegram.sendMessage(order.userId, 
                        `✅ <b>THÀNH CÔNG!</b>\nMã đơn: <b>${result.finalOrderId}</b>\n📦 <b>Tài khoản:</b>\n<pre>${accStr}</pre>`, 
                        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🛍️ Mua tiếp', 'refresh')]]) }
                    );
                    
                    CONFIG.ADMIN_ID.forEach(id => {
                        bot.telegram.sendMessage(id, `💰 Đơn mới: ${result.finalOrderId} (${order.total.toLocaleString()}đ)`).catch(()=>{});
                    });
                    
                    pendingOrders.delete(orderCode);
                } else {
                    console.error("Lỗi kho:", result.reason);
                    bot.telegram.sendMessage(CONFIG.ADMIN_ID[0], `⚠️ Lỗi đơn ${orderCode}: ${result.reason}`);
                }
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