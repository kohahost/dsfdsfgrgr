// stellar-sdk v8.x tidak memerlukan .default
const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
const fs = require('fs');
require("dotenv").config();
const { URLSearchParams } = require('url');
const { ProxyAgent, request } = require('undici'); // Import dari undici

// --- KONFIGURASI ---
const DELAY_BETWEEN_WALLETS_MS = 1000; // Jeda antar pemrosesan wallet (dalam milidetik)
const PI_API_SERVER = 'https://api.mainnet.minepi.com';
const PI_NETWORK_PASSPHRASE = 'Pi Network';
const server = new StellarSdk.Server(PI_API_SERVER);

// Daftar proxy berbayar Anda.
const proxyList = [
    "https://bcd60f77c870ab96006e:6337aa71b03ff7e8@ip.proxynet.top:823",
    "https://bcd60f77c870ab96006e__cr.ad:6337aa71b03ff7e8@ip.proxynet.top:20000",
    "https://bcd60f77c870ab96006e__cr.ae:6337aa71b03ff7e8@ip.proxynet.top:20000",
    "https://bcd60f77c870ab96006e:6337aa71b03ff7e8@ip.proxynet.top:823",
    "https://bcd60f77c870ab96006e__cr.ad:6337aa71b03ff7e8@ip.proxynet.top:20000",
    "https://bcd60f77c870ab96006e__cr.ae:6337aa71b03ff7e8@ip.proxynet.top:20000",
    "https://bcd60f77c870ab96006e:6337aa71b03ff7e8@ip.proxynet.top:823",
    "https://bcd60f77c870ab96006e__cr.ad:6337aa71b03ff7e8@ip.proxynet.top:20000",
    "https://bcd60f77c870ab96006e__cr.ae:6337aa71b03ff7e8@ip.proxynet.top:20000",
    "https://bcd60f77c870ab96006e:6337aa71b03ff7e8@ip.proxynet.top:823",
    "https://bcd60f77c870ab96006e__cr.ad:6337aa71b03ff7e8@ip.proxynet.top:20000",
    "https://bcd60f77c870ab96006e__cr.ae:6337aa71b03ff7e8@ip.proxynet.top:20000",
    "https://bcd60f77c870ab96006e__cr.vn:6337aa71b03ff7e8@ip.proxynet.top:823"
];

/**
 * Mengirim notifikasi ke bot Telegram.
 */
async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.warn("⚠️ Variabel Telegram (TOKEN/CHAT_ID) belum diatur di file .env. Notifikasi dilewati.");
        return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
        console.log("📬 Notifikasi Telegram berhasil dikirim.");
    } catch (error) {
        console.error("❌ Gagal mengirim notifikasi Telegram:", error.response?.data?.description || error.message);
    }
}

/**
 * Memuat frasa mnemonik dari file mnemonics.txt.
 */
function loadMnemonics() {
    try {
        const data = fs.readFileSync('mnemonics.txt', 'utf8');
        return data.split(/\r?\n/).filter(line => line.trim() !== '');
    } catch (err) {
        console.error('❌ Error: Tidak dapat membaca file mnemonics.txt. Pastikan file tersebut ada.');
        process.exit(1);
    }
}

/**
 * Menghasilkan alamat publik dan kunci rahasia Pi Wallet dari frasa mnemonik.
 */
async function getPiWalletAddressFromSeed(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("Format mnemonic tidak valid (salah kata atau jumlah).");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const derivationPath = "m/44'/314159'/0'"; // Derivasi path standar untuk Pi Network
    const { key } = ed25519.derivePath(derivationPath, seed.toString('hex'));
    const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);
    return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

/**
 * Mengirim transaksi yang sudah ditandatangani ke jaringan Pi Network melalui berbagai proxy.
 */
async function submitTransactionWithProxies(xdr) {
    console.log('Menerima XDR. Mencoba submit secara paralel melalui proxy...');

    const formData = new URLSearchParams();
    formData.append("tx", xdr);

    const horizonSubmitURL = PI_API_SERVER + "/transactions";

    const requestPromises = proxyList.map(proxyUrl => {
        // console.log(`Menyiapkan request melalui proxy: ${new URL(proxyUrl).hostname}`); // Debugging optional
        const dispatcher = new ProxyAgent(proxyUrl);
        return request(horizonSubmitURL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: formData.toString(),
            dispatcher: dispatcher,
            bodyTimeout: 1000, // 1 detik
            headersTimeout: 1000,
        });
    });

    try {
        const successfulResponse = await Promise.any(requestPromises);
        const body = await successfulResponse.body.json();
        console.log(`✅ Request berhasil dengan status: ${successfulResponse.statusCode}. Menggunakan salah satu proxy.`);
        return body;
    } catch (error) {
        // AggregateError memiliki properti 'errors' yang berisi semua error dari promise yang gagal
        const errorDetails = error.errors ? error.errors.map(e => e.message).join('; ') : error.message;
        console.error(`❌ Error: Semua proxy gagal atau timeout. Detail: ${errorDetails}`);
        throw new Error(`Gagal submit transaksi ke Horizon: Semua proxy gagal atau timeout. Details: ${errorDetails}`);
    }
}

/**
 * Mengirim saldo berlebih di atas 1 Pi dari satu wallet.
 */
async function sendMaxAmount(mnemonic, recipient, walletIndex) {
    let wallet;
    try {
        wallet = await getPiWalletAddressFromSeed(mnemonic);
        const senderPublic = wallet.publicKey;
        console.log(`🔑 Memproses Wallet #${walletIndex + 1}: ${senderPublic.substring(0, 10)}...`);

        const account = await server.loadAccount(senderPublic);
        const balanceLine = account.balances.find(b => b.asset_type === 'native');
        const balance = parseFloat(balanceLine.balance);
        console.log(`💰 Saldo terdeteksi: ${balance} Pi`);

        if (balance < 1.01) { // 1 Pi untuk cadangan, 0.01 Pi untuk buffer biaya
            console.log("⚠️ Saldo di bawah 1.01 Pi. Tidak cukup untuk cadangan minimum & biaya. Melewati...");
            return;
        }

        const feeInStroops = await server.fetchBaseFee(); // Biaya transaksi dasar
        // Hitung jumlah yang akan dikirim: saldo - cadangan minimal (1 Pi) - biaya
        const amountToSend = balance - 1 - (feeInStroops / 1e7); // 1e7 stroops = 1 XLM/Pi

        if (amountToSend <= 0) {
            console.log("⚠️ Tidak ada saldo yang bisa dikirim di atas cadangan minimum. Melewati...");
            return;
        }

        const formattedAmount = amountToSend.toFixed(7);
        console.log(`➡️ Mengirim: ${formattedAmount} Pi ke ${recipient.substring(0, 10)}...`);

        // --- Perubahan untuk mendukung Muxed Account ---
        let destinationAccount;
        try {
            // Coba parsing recipient sebagai MuxedAccount terlebih dahulu
            // Stellar SDK akan secara otomatis mengelola ID memo jika valid
            destinationAccount = StellarSdk.MuxedAccount.fromMuxedAccount(recipient);
            console.log(`ℹ️ Tujuan terdeteksi sebagai Muxed Account: ${recipient}`);
        } catch (e) {
            // Jika bukan Muxed Account, anggap sebagai alamat publik standar (G-address)
            destinationAccount = recipient;
            console.log(`ℹ️ Tujuan terdeteksi sebagai Alamat Publik standar: ${recipient}`);
        }
        // --- Akhir Perubahan untuk mendukung Muxed Account ---


        const tx = new StellarSdk.TransactionBuilder(account, { fee: feeInStroops.toString(), networkPassphrase: PI_NETWORK_PASSPHRASE })
            .addOperation(StellarSdk.Operation.payment({
                destination: destinationAccount, // Gunakan destinationAccount yang sudah di-parse
                asset: StellarSdk.Asset.native(),
                amount: formattedAmount.toString(),
            }))
            .setTimeout(30) // Transaksi akan kedaluwarsa dalam 30 detik
            .build();

        const senderKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
        tx.sign(senderKeypair);

        // Menggunakan fungsi submitTransactionWithProxies untuk mengirim XDR
        const result = await submitTransactionWithProxies(tx.toXDR());

        if (result && result.hash) {
            console.log("✅ Transaksi Berhasil! Saldo telah dikirim. Hash:", result.hash);
            const notificationMessage = `
✅ <b>Transfer Berhasil!</b>

<b>Jumlah:</b> <code>${formattedAmount} Pi</code>
<b>Dari:</b> <code>${senderPublic.substring(0, 5)}...${senderPublic.substring(senderPublic.length - 5)}</code>
<b>Ke:</b> <code>${recipient.substring(0, 5)}...${recipient.substring(recipient.length - 5)}</code>

<a href="https://blockexplorer.minepi.com/mainnet/transactions/${result.hash}">Lihat Transaksi</a>`;
            await sendTelegramNotification(notificationMessage.trim());
        } else {
            console.error("❌ GAGAL KONFIRMASI: Server tidak mengembalikan hash transaksi yang valid.");
            await sendTelegramNotification(`❌ <b>Transfer Gagal!</b> Tidak ada hash transaksi yang valid dari wallet ${senderPublic.substring(0, 5)}...`);
        }

    } catch (e) {
        const address = wallet ? wallet.publicKey.substring(0, 10) + '...' : 'unknown';
        let errorMessage = `❌ Error Umum untuk Wallet ${address}: ${e.message || e}`;

        if (e.message && e.message.includes("Format mnemonic tidak valid")) {
            errorMessage = `❌ Error untuk Mnemonic #${walletIndex + 1}: ${e.message}`;
        } else if (e.response && e.response.status === 404) {
            errorMessage = `❌ GAGAL: Wallet ${address} tidak ditemukan/belum diaktifkan di Mainnet.`;
        } else if (e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes.transaction === 'tx_insufficient_balance') {
            errorMessage = `❌ GAGAL: Wallet ${address} tidak memiliki saldo yang cukup untuk biaya transaksi.`;
        } else if (e.message && e.message.includes("Gagal submit transaksi ke Horizon: Semua proxy gagal atau timeout.")) {
            errorMessage = `❌ ${e.message}`; // Gunakan pesan error dari fungsi submitTransactionWithProxies
        }
        console.error(errorMessage);
        await sendTelegramNotification(`❌ <b>Transfer Gagal!</b> dari wallet ${address.substring(0, 5)}...\n\nDetail: ${errorMessage}`);
    }
}

let walletIndex = 0;
async function main() {
    console.log("🚀 Memulai Bot Pengirim Saldo Pi...");
    console.log("ℹ️ Bot ini akan mencoba mengirim saldo di atas 1 Pi dari setiap wallet.");

    const mnemonics = loadMnemonics();
    const recipient = process.env.RECEIVER_ADDRESS;

    if (!recipient || (!recipient.startsWith('G') && !recipient.startsWith('M'))) {
        console.error("❌ Error: RECEIVER_ADDRESS tidak valid atau tidak ditemukan di file .env. Pastikan dimulai dengan 'G' atau 'M'.");
        return;
    }
    if (mnemonics.length === 0) {
        console.error("❌ Error: Tidak ada mnemonic yang ditemukan di mnemonics.txt.");
        return;
    }

    console.log(`✔️ Berhasil memuat ${mnemonics.length} wallet.`);
    console.log(`🎯 Alamat tujuan: ${recipient}`);
    console.log("-------------------------------------------------------------------------------------");

    while (true) {
        const mnemonic = mnemonics[walletIndex];

        console.log(`\n[${new Date().toLocaleString('id-ID')}] Memproses Wallet #${walletIndex + 1}/${mnemonics.length}`);
        await sendMaxAmount(mnemonic, recipient, walletIndex);
        console.log("-------------------------------------------------------------------------------------");

        walletIndex = (walletIndex + 1) % mnemonics.length;
        if (walletIndex === 0) {
            console.log(`\n🔄 Semua ${mnemonics.length} wallet telah diproses. Mengulang dari awal setelah jeda ${DELAY_BETWEEN_WALLETS_MS / 1000} detik...\n`);
        }

        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_WALLETS_MS));
    }
}

main();
