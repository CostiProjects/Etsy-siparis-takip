const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // Etsy istekleri için eklendi

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const dbPath = path.join(__dirname, 'database.json');

//! DOLDURULACAK API ALANI

const ETSY_CLIENT_ID = "";     //? CONSUMER KEY
const ETSY_CLIENT_SECRET = ""; //? SHARED SECRET (CONSUMER SECRET)
const ETSY_SHOP_ID = "";       //? MAGAZA ID
const REDIRECT_URI = "http://localhost:3000/oauth/redirect"; //? Etsy panelinde belirtilen URL
// ==========================================

app.use(express.json());
app.use(express.static(__dirname));

function readDB() {
    if (!fs.existsSync(dbPath)) {
        
         //* VERITABANI YOKSA SIMULASYONA DEVAMM

        const initialTemplate = { users: [{ username: "admin", password: "123", role: "manager", name: "Müdür" }], employeeStatus: {}, orders: [], etsyAuth: {} };
        fs.writeFileSync(dbPath, JSON.stringify(initialTemplate, null, 2), 'utf8');
    }
    const data = fs.readFileSync(dbPath, 'utf8');
    return JSON.parse(data);
}

function writeDB(data) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
}

function generateOrderCode(employeeName) {
    let prefix = employeeName.replace(/[aeıioöuüAEIİOÖUÜ]/g, '').toUpperCase();
    if (prefix.length < 3) prefix = employeeName.substring(0, 3).toUpperCase();
    prefix = prefix.substring(0, 3);
    const randomNumber = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}-${randomNumber}`;
}

//! DOĞRULAMA SISTEMI AUTH KORUMA

//! ETSY IZIN SAYFASI
app.get('/oauth/connect', (req, res) => {
    if (!ETSY_CLIENT_ID) return res.send("Hata: Sunucu kodunda ETSY_CLIENT_ID boş Önce doldurun.");
    
    const state = Math.random().toString(36).substring(7);
    const codeChallenge = "O_XpX_EXAMPLE_CHALLENGE_STRING_FOR_V3_OAUTH_CODE_VERIFIER"; 
    
    const etsyAuthUrl = `https://www.etsy.com/oauth/connect?` +
        `response_type=code&` +
        `client_id=${ETSY_CLIENT_ID}&` +
        `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
        `scope=transactions_r%20transactions_w%20shops_r&` +
        `state=${state}&` +
        `code_challenge=${codeChallenge}&` +
        `code_challenge_method=S256`;
        
    res.redirect(etsyAuthUrl);
});

//! IZINDEN SONRA GERI DONUS
app.get('/oauth/redirect', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.send("Etsy entegrasyon izni reddedildi.");

    try {
        
        const response = await axios.post('https://api.etsy.com/v3/public/oauth/token', {
            grant_type: 'authorization_code',
            client_id: ETSY_CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            code: code,
            code_verifier: "O_XpX_EXAMPLE_CHALLENGE_STRING_FOR_V3_OAUTH_CODE_VERIFIER"
        });

        const db = readDB();
        db.etsyAuth = {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
            expires_at: Date.now() + (response.data.expires_in * 1000)
        };
        writeDB(db);

        res.send("<h2>Etsy Mağazanız Başarıyla Paneline Bağlandı!</h2><p>Bu sekmeyi kapatıp sipariş paneline geri dönebilirsiniz.</p>");
        io.emit('dataChanged', db);
        fetchLiveEtsyOrders(); // Hemen canlı ilk çekimi tetikle
    } catch (error) {
        console.error("Token alınırken hata oluştu:", error.response?.data || error.message);
        res.status(500).send("Etsy token alma işleminde teknik bir hata oluştu.");
    }
});

//! TOKEN YENILEYICI
async function refreshEtsyToken(db) {
    try {
        const response = await axios.post('https://api.etsy.com/v3/public/oauth/token', {
            grant_type: 'refresh_token',
            client_id: ETSY_CLIENT_ID,
            refresh_token: db.etsyAuth.refresh_token
        });

        db.etsyAuth.access_token = response.data.access_token;
        db.etsyAuth.refresh_token = response.data.refresh_token;
        db.etsyAuth.expires_at = Date.now() + (response.data.expires_in * 1000);
        writeDB(db);
        return response.data.access_token;
    } catch (error) {
        console.error("Token yenileme başarısız (Müdürün tekrar bağlanması gerekebilir):", error.message);
        return null;
    }
}

//! SİPARİŞ ÇEKER
async function fetchLiveEtsyOrders() {
    const db = readDB();
    if (!db.etsyAuth || !db.etsyAuth.refresh_token || !ETSY_SHOP_ID || !ETSY_CLIENT_ID) {
       //! AYARLAR KORUMASI EKLEDIK
        return;
    }

    let token = db.etsyAuth.access_token;
    //! SÜRESİ BİTENİ YENİLE
    if (Date.now() >= db.etsyAuth.expires_at) {
        token = await refreshEtsyToken(db);
        if (!token) return;
    }

    try {
        //! SİPARİŞLERİ LİSTELE
        const response = await axios.get(`https://api.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/receipts?was_paid=true&was_shipped=false`, {
            headers: {
                'x-api-key': ETSY_CLIENT_ID,
                'Authorization': `Bearer ${token}`
            }
        });

        const etsyReceipts = response.data.results || [];
        let dataUpdated = false;

        etsyReceipts.forEach(receipt => {
            //! SİPARİŞ LİSTEDE KAYITLI DEĞİLSE YENİDEN EKLE
            const exists = db.orders.some(o => o.id == receipt.receipt_id);
            if (!exists) {
                const newOrder = {
                    id: receipt.receipt_id, //! GERÇEK SİPARİŞ NO
                    orderCode: "-", 
                    shopName: receipt.seller_user_id == ETSY_SHOP_ID ? "Çanta Mağazası A" : "Etsy Canlı Mağaza", 
                    customerName: receipt.buyer_email || "Etsy Müşterisi",
                    requirements: receipt.message_from_buyer || "Özel istek belirtilmemiş (Boş Sipariş).",
                    orderStatus: "Beklemede",
                    createdAt: new Date(receipt.created_timestamp * 1000).toISOString(),
                    claimedAt: null,
                    completedAt: null,
                    updatedAt: new Date().toISOString(),
                    assignedEmployee: null
                };
                db.orders.unshift(newOrder); //! YENI GELENI ÜSTE AL
                dataUpdated = true;
            }
        });

        if (dataUpdated) {
            writeDB(db);
            io.emit('dataChanged', db);
            console.log("Etsy'den yeni siparişler çekildi ve paneline senkronize edildi!");
        }
    } catch (error) {
        console.error("Etsy siparişleri çekilirken hata:", error.response?.data || error.message);
    }
}

//! HER 3 DAKİKADA 1 KONTROL ET APİYİ
setInterval(fetchLiveEtsyOrders, 3 * 60 * 1000);


app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username === username.toLowerCase() && u.password === password);
    if (user) {
        res.json({ success: true, user: { username: user.username, name: user.name, role: user.role } });
    } else {
        res.status(401).json({ success: false, message: 'Hatalı kullanıcı adı veya şifre!' });
    }
});

app.post('/api/add-employee', (req, res) => {
    const { username, password, name } = req.body;
    const db = readDB();
    if (db.users.some(u => u.username === username.toLowerCase())) {
        return res.status(400).json({ success: false, message: 'Bu kullanıcı adı zaten mevcut!' });
    }
    db.users.push({ username: username.toLowerCase(), password, role: 'employee', name });
    db.employeeStatus[username.toLowerCase()] = { status: "Uyku Modunda", lastActivity: "" };
    writeDB(db);
    io.emit('dataChanged', db);
    res.json({ success: true, message: 'Yeni çalışan başarıyla eklendi!' });
});

app.post('/api/delete-employee', (req, res) => {
    const { username } = req.body;
    const db = readDB();
    const userIndex = db.users.findIndex(u => u.username === username.toLowerCase() && u.role === 'employee');
    if (userIndex === -1) return res.status(404).json({ success: false, message: 'Çalışan bulunamadı!' });

    db.users.splice(userIndex, 1);
    delete db.employeeStatus[username.toLowerCase()];
    db.orders.forEach(order => {
        if (order.assignedEmployee === username.toLowerCase() && order.orderStatus !== "Tamamlandı") {
            order.orderCode = "-";
            order.assignedEmployee = null;
            order.orderStatus = "Beklemede";
            order.claimedAt = null;
            order.updatedAt = null;
        }
    });
    writeDB(db);
    io.emit('dataChanged', db);
    res.json({ success: true, message: 'Çalışan silindi ve işleri boşa çıkarıldı!' });
});

io.on('connection', (socket) => {
    socket.emit('initData', readDB());

    socket.on('updateStatus', ({ username, status }) => {
        const db = readDB();
        if (db.employeeStatus[username]) {
            db.employeeStatus[username].status = status;
            db.employeeStatus[username].lastActivity = new Date().toISOString();
            if (status === "Uyku Modunda") {
                db.orders.forEach(order => { if (order.assignedEmployee === username && order.orderStatus === "Hazırlanıyor") order.orderStatus = "Duraklatıldı"; });
            } else if (status === "Aktif") {
                db.orders.forEach(order => { if (order.assignedEmployee === username && order.orderStatus === "Duraklatıldı") order.orderStatus = "Hazırlanıyor"; });
            }
            writeDB(db);
            io.emit('dataChanged', db);
        }
    });

    socket.on('claimOrder', ({ orderId, username, employeeName }) => {
        const db = readDB();
        const order = db.orders.find(o => o.id == orderId);
        if (order && order.orderStatus === "Beklemede") {
            order.orderCode = generateOrderCode(employeeName);
            order.assignedEmployee = username;
            const currentStatus = db.employeeStatus[username]?.status || "Aktif";
            order.orderStatus = currentStatus === "Aktif" ? "Hazırlanıyor" : "Duraklatıldı";
            const now = new Date().toISOString();
            order.claimedAt = now;
            order.updatedAt = now;
            writeDB(db);
            io.emit('dataChanged', db);
        }
    });

    socket.on('completeOrder', ({ orderId }) => {
        const db = readDB();
        const order = db.orders.find(o => o.id == orderId);
        if (order && (order.orderStatus === "Hazırlanıyor" || order.orderStatus === "Duraklatıldı")) {
            order.orderStatus = "Tamamlandı";
            const now = new Date().toISOString();
            order.completedAt = now;
            order.updatedAt = now;
            writeDB(db);
            io.emit('dataChanged', db);
        }
    });

    socket.on('managerUpdateStatus', ({ orderId, newStatus }) => {
        const db = readDB();
        const order = db.orders.find(o => o.id == orderId);
        if (order) {
            order.orderStatus = newStatus;
            const now = new Date().toISOString();
            order.updatedAt = now;
            if (newStatus === "Tamamlandı") {
                if (!order.claimedAt) order.claimedAt = now;
                order.completedAt = now;
            } else if (newStatus === "Beklemede") {
                order.orderCode = "-";
                order.assignedEmployee = null;
                order.claimedAt = null;
                order.completedAt = null;
            } else {
                order.completedAt = null;
                if (!order.claimedAt) order.claimedAt = now;
            }
            writeDB(db);
            io.emit('dataChanged', db);
        }
    });
});

server.listen(PORT, () => {
    console.log(`APILERI BAGLADIM: http://localhost:${PORT}`);
});