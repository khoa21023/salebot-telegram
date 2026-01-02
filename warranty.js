require('dotenv').config(); // <--- BẮT BUỘC THÊM DÒNG NÀY

const { Telegraf, Markup } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// ================= 1. CẤU HÌNH (ĐÃ BẢO MẬT) =================
const CONFIG = {
    // Đọc từ biến môi trường
    BOT_TOKEN: process.env.BOT_TOKEN_WARRANTY, // Bạn nên đặt tên khác trong .env để tránh trùng với bot bán hàng
    SHEET_ID: process.env.SHEET_ID,
    GOOGLE_EMAIL: process.env.GOOGLE_EMAIL,
    GOOGLE_KEY: process.env.GOOGLE_KEY ? process.env.GOOGLE_KEY.replace(/\\n/g, '\n') : '',
    
    // Lấy Admin ID từ file .env
    ADMIN_ID: [ 
        parseInt(process.env.ADMIN_ID_1),
        parseInt(process.env.ADMIN_ID_2)
    ].filter(Boolean), 
    
    ZALO_INFO: '0346600098' 
};

// ================= 2. KHỞI TẠO =================
const bot = new Telegraf(CONFIG.BOT_TOKEN);

const serviceAccountAuth = new JWT({
    email: CONFIG.GOOGLE_EMAIL,
    key: CONFIG.GOOGLE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(CONFIG.SHEET_ID, serviceAccountAuth);

// Lưu trạng thái
const warrantyState = new Map();

// Hàm gửi thông báo cho TẤT CẢ Admin
async function notifyAdmin(message, extra = {}) {
    for (const id of CONFIG.ADMIN_ID) {
        try {
            await bot.telegram.sendMessage(id, message, { parse_mode: 'HTML', ...extra });
        } catch (e) { console.error(`Lỗi gửi admin ${id}:`, e.message); }
    }
}

// ================= 3. LOGIC BOT =================

// [CẬP NHẬT] MENU CHÍNH CÓ 2 NÚT
bot.start((ctx) => {
    warrantyState.delete(ctx.from.id);
    ctx.reply(
        `🛠 <b>TRUNG TÂM HỖ TRỢ</b>\nChào mừng bạn! Vui lòng chọn tính năng:`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🛡 Yêu cầu Bảo hành', 'start_warranty')],
                [Markup.button.callback('📞 Liên hệ Admin', 'contact_admin_main')] // <--- NÚT MỚI
            ])
        }
    );
});

// [MỚI] XỬ LÝ NÚT LIÊN HỆ TỪ MENU CHÍNH
bot.action('contact_admin_main', async (ctx) => {
    const userId = ctx.from.id;
    
    // Đặt trạng thái Chat ngay lập tức (Mã đơn để là 'Chưa cung cấp')
    warrantyState.set(userId, { step: 'CHAT_WITH_ADMIN', orderId: 'Chưa cung cấp' });

    // Báo Admin
    await notifyAdmin(
        `🔔 <b>CÓ KHÁCH MUỐN GẶP ADMIN (Từ Menu)!</b>\n` +
        `👤 User: @${ctx.from.username} (ID: ${userId})\n` +
        `👉 Khách đang vào hộp chat...`
    );

    // Hiển thị giao diện Chat
    await ctx.editMessageText(
        `📞 <b>KẾT NỐI VỚI ADMIN</b>\n\n` +
        `Hệ thống đã kết nối bạn với Admin.\n` +
        `Bạn có thể nhắn tin trình bày vấn đề ngay tại đây (Bot sẽ chuyển tin nhắn đi).\n\n` +
        `Hoặc liên hệ Zalo: <b>${CONFIG.ZALO_INFO}</b>`, 
        { parse_mode: 'HTML' }
    );
});

bot.action('start_warranty', (ctx) => {
    warrantyState.set(ctx.from.id, { step: 'INPUT_ORDER_ID' });
    ctx.editMessageText(
        `✍️ Vui lòng nhập <b>MÃ ĐƠN HÀNG</b> bạn muốn bảo hành:\n(Ví dụ: 851462298)`,
        { parse_mode: 'HTML' }
    );
});

// XỬ LÝ TIN NHẮN (Mã đơn + Chat với Admin)
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();

    if (!warrantyState.has(userId)) return;
    const state = warrantyState.get(userId);

    // --- TRƯỜNG HỢP 1: KHÁCH ĐANG CHAT VỚI ADMIN ---
    if (state.step === 'CHAT_WITH_ADMIN') {
        await notifyAdmin(
            `📩 <b>TIN NHẮN TỪ KHÁCH</b>\n👤 @${ctx.from.username} (ID: ${userId})\n📦 Đơn: ${state.orderId}\n💬 <i>"${text}"</i>`
        );
        return ctx.reply('✅ Đã gửi tin nhắn cho Admin.');
    }

    // --- TRƯỜNG HỢP 2: KHÁCH NHẬP MÃ ĐƠN ---
    if (state.step === 'INPUT_ORDER_ID') {
        const msg = await ctx.reply('⏳ Đang kiểm tra hệ thống...');
        
        try {
            await doc.loadInfo();
            const sheet = doc.sheetsByTitle['LichSu'];
            const rows = await sheet.getRows();

            // 1. TÌM TẤT CẢ CÁC DÒNG CÓ CÙNG MÃ ĐƠN
            const orderRows = rows.filter(r => String(r.get('ma_don')) === text);

            if (orderRows.length === 0) {
                await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);
                return ctx.reply('❌ Không tìm thấy đơn hàng này. Vui lòng kiểm tra lại.');
            }

            // 2. CHECK ID NGƯỜI DÙNG
            const buyerId = String(orderRows[0].get('user_id'));
            if (buyerId !== String(userId)) {
                await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);
                return ctx.reply('⛔ <b>Sai tài khoản!</b>\nVui lòng dùng đúng tài khoản Telegram đã mua hàng.', { parse_mode: 'HTML' });
            }

            const productName = orderRows[0].get('san_pham');
            const quantity = orderRows.length;

            await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);
            
            // Lưu trạng thái
            warrantyState.set(userId, { 
                step: 'SELECT_REASON', 
                orderId: text, 
                quantity: quantity,
                productName: productName
            });

            await ctx.reply(
                `✅ <b>Xác thực thành công!</b>\n` +
                `📦 Đơn hàng: <code>${text}</code>\n` +
                `🛍 Sản phẩm: <b>${productName}</b>\n` +
                `🔢 Số lượng: <b>${quantity}</b> acc\n\n` +
                `Vui lòng chọn vấn đề bạn gặp phải:`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('Tài khoản ngưng hoạt động', 'err_inactive')],
                        [Markup.button.callback('Xác minh số điện thoại', 'err_verify')],
                        [Markup.button.callback('Lỗi Khác', 'err_other')],
                        [Markup.button.callback('Liên hệ Admin (Chat)', 'err_contact')],
                    ])
                }
            );

        } catch (e) {
            console.error(e);
            ctx.reply('❌ Lỗi hệ thống: ' + e.message);
        }
    }
});

// XỬ LÝ CÁC NÚT CHỌN LỖI
bot.action(/err_(.+)/, async (ctx) => {
    const type = ctx.match[1];
    const userId = ctx.from.id;
    const state = warrantyState.get(userId);

    if (!state || !state.orderId) return ctx.reply('⚠️ Hết hạn phiên. Bấm /start lại.');
    
    const { orderId, quantity, productName } = state;
    let reasonText = '';

    // === XỬ LÝ CHAT ADMIN TỪ MENU BÊN TRONG ===
    if (type === 'contact') {
        warrantyState.set(userId, { step: 'CHAT_WITH_ADMIN', orderId: orderId });
        notifyAdmin(`🔔 <b>CÓ KHÁCH MUỐN GẶP ADMIN!</b>\n👤 @${ctx.from.username}\n📦 Đơn: ${orderId}`);
        return ctx.editMessageText(
            `📞 <b>KẾT NỐI VỚI ADMIN</b>\nBạn có thể nhắn tin vấn đề tại đây. Hoặc Zalo: <b>${CONFIG.ZALO_INFO}</b>`, 
            { parse_mode: 'HTML' }
        );
    }

    // === XỬ LÝ GỬI BẢO HÀNH ===
    switch (type) {
        case 'inactive': reasonText = 'Tài khoản ngưng hoạt động'; break;
        case 'verify': reasonText = 'Yêu cầu xác minh SĐT'; break;
        case 'other': reasonText = 'Lỗi khác'; break;
    }

    const msg = await ctx.reply('⏳ Đang gửi yêu cầu cho toàn bộ đơn hàng...');

    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['BaoHanh'];
        
        for(let i = 0; i < quantity; i++) {
            await sheet.addRow({
                ma_don: orderId,
                user_id: userId,
                username: ctx.from.username || 'NoName',
                san_pham: productName,
                loi_gap_phai: reasonText,
                trang_thai: 'Pending',
                ngay_yeu_cau: new Date().toLocaleString('vi-VN')
            });
        }

        // BÁO ADMIN + NÚT DUYỆT TỰ ĐỘNG
        await notifyAdmin(
            `🆘 <b>YÊU CẦU BẢO HÀNH (1 ĐỔI 1)!</b>\n` +
            `📦 Đơn: <b>${orderId}</b>\n` +
            `🛍 SP: ${productName} (x${quantity})\n` +
            `⚠️ Lỗi: ${reasonText}\n` +
            `👤 Khách: @${ctx.from.username}`,
            Markup.inlineKeyboard([
                [Markup.button.callback(`✅ Duyệt & Đổi Mới (${quantity} acc)`, `approve_warranty_${orderId}`)],
                [Markup.button.callback('💬 Nhắn tin cho khách', 'ignore_for_now')]
            ])
        );

        warrantyState.delete(userId);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, 
            `✅ <b>ĐÃ GỬI YÊU CẦU!</b>\nHệ thống đã ghi nhận bảo hành cho <b>${quantity}</b> tài khoản.\nVui lòng chờ Admin phê duyệt.`,
            { parse_mode: 'HTML' }
        );

    } catch (e) {
        ctx.reply('❌ Lỗi: ' + e.message);
    }
});

// ================= ADMIN DUYỆT BẢO HÀNH (CÓ BÁO HẾT HÀNG) =================

bot.action(/approve_warranty_(.+)/, async (ctx) => {
    if (!CONFIG.ADMIN_ID.includes(ctx.from.id)) return ctx.answerCbQuery('⛔ Chỉ Admin mới được bấm!');

    const orderId = ctx.match[1];
    await ctx.editMessageText(`⏳ Đang xử lý đơn ${orderId}...`);

    try {
        await doc.loadInfo();
        
        // 1. Đọc yêu cầu từ Sheet BaoHanh
        const sheetBH = doc.sheetsByTitle['BaoHanh'];
        const rowsBH = await sheetBH.getRows();
        const pendingRows = rowsBH.filter(r => String(r.get('ma_don')) === orderId && r.get('trang_thai') === 'Pending');

        if (pendingRows.length === 0) return ctx.editMessageText('⚠️ Đơn này đã xong hoặc không tìm thấy.');

        const qtyNeeded = pendingRows.length;
        let productName = pendingRows[0].get('san_pham'); // Lấy tên SP
        const customerId = pendingRows[0].get('user_id');

        // --- [FIX LỖI] NẾU SHEET BẢO HÀNH BỊ TRỐNG TÊN SP, TỰ TÌM LẠI BÊN LỊCH SỬ ---
        if (!productName || productName === 'undefined') {
            const sheetLS = doc.sheetsByTitle['LichSu'];
            const rowsLS = await sheetLS.getRows();
            const originalOrder = rowsLS.find(r => String(r.get('ma_don')) === orderId);
            if (originalOrder) {
                productName = originalOrder.get('san_pham'); // Cứu cánh: Lấy lại từ lịch sử gốc
            } else {
                return ctx.editMessageText(`❌ Lỗi nghiêm trọng: Không tìm thấy tên sản phẩm của đơn ${orderId} ở đâu cả!`);
            }
        }
        // --------------------------------------------------------------------------

        // 2. TÌM ID SẢN PHẨM TRONG MATHANG
        const sheetMH = doc.sheetsByTitle['MatHang'];
        const rowsMH = await sheetMH.getRows();
        const productInfo = rowsMH.find(r => r.get('ten_hang') === productName);

        if (!productInfo) {
            return ctx.editMessageText(`❌ Lỗi: Không tìm thấy sản phẩm tên "${productName}" trong bảng MatHang.`);
        }
        const productId = productInfo.get('id');

        // ... (Phần code xử lý kho phía sau giữ nguyên như cũ) ...
        // Bạn copy tiếp phần check kho và trả hàng từ code cũ vào đây nhé
        
        // --- ĐOẠN DƯỚI NÀY LÀ CỦA CODE CŨ, MÌNH CHÉP LẠI CHO ĐỦ BỘ ---
        const sheetKho = doc.sheetsByTitle['KhoHang'];
        const rowsKho = await sheetKho.getRows();
        const availableAccs = rowsKho.filter(r => r.get('loai_hang') === productId && r.get('status') === 'chưa bán');

        if (availableAccs.length < qtyNeeded) {
             await ctx.editMessageText(`❌ KHO HẾT HÀNG! Cần ${qtyNeeded} acc ${productName}. Đã báo khách chờ.`);
             try { await bot.telegram.sendMessage(customerId, `⚠️ Admin đã duyệt bảo hành nhưng kho ${productName} đang tạm hết. Vui lòng chờ thêm chút nhé!`); } catch(e){}
             return;
        }

        const accsToGive = availableAccs.slice(0, qtyNeeded);
        const accListText = [];
        for (const row of accsToGive) {
            accListText.push(`${row.get('username')} | ${row.get('password')}`);
            row.assign({ status: 'đã bảo hành' });
            await row.save();
        }
        for (const row of pendingRows) {
            row.assign({ trang_thai: 'Completed' });
            await row.save();
        }

        await bot.telegram.sendMessage(customerId, 
            `✅ <b>BẢO HÀNH THÀNH CÔNG!</b>\nĐơn: ${orderId}\n📦 Tài khoản mới:\n<pre>${accListText.join('\n')}</pre>`,
            { parse_mode: 'HTML' }
        );
        await ctx.editMessageText(`✅ Đã đổi trả thành công ${qtyNeeded} acc!`);
    } catch (e) {
        console.error(e);
        ctx.editMessageText(`❌ Lỗi: ${e.message}`);
    }
});

// Admin Reply
bot.on('message', async (ctx) => {
    if (CONFIG.ADMIN_ID.includes(ctx.from.id) && ctx.message.reply_to_message) {
        const originalText = ctx.message.reply_to_message.text;
        const match = originalText.match(/ID: (\d+)/);
        if (match) {
            const customerId = match[1];
            try {
                await bot.telegram.sendMessage(customerId, 
                    `👨‍💻 <b>ADMIN TRẢ LỜI:</b>\n${ctx.message.text}`, 
                    { parse_mode: 'HTML' }
                );
                ctx.reply('✅ Đã gửi.');
            } catch (e) {
                ctx.reply('❌ Lỗi gửi tin (Khách chặn bot?).');
            }
        }
    }
});

bot.launch();
console.log('🛡 Warranty Bot V5 (Final) Running...');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));