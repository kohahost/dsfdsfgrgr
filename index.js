const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// --- PENGATURAN ---
const DELAY_MS = 1000; // Jeda 1 detik agar tidak membebani server
const PI_API = 'https://api.mainnet.minepi.com';
const server = new StellarSdk.Server(PI_API);
const NETWORK_PASSPHRASE = 'Pi Network';

async function sendTelegram(msg) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId, text: msg, parse_mode: 'HTML', disable_web_page_preview: true
        });
        console.log("📬 Notifikasi Telegram berhasil dikirim.");
    } catch (err) {
        console.error("❌ Gagal mengirim notifikasi Telegram:", err.response?.data || err.message);
    }
}

function loadMnemonics() {
    try {
        const data = fs.readFileSync('mnemonics.txt', 'utf8');
        return data.split(/\r?\n/).filter(line => line.trim() !== '');
    } catch (err) {
        console.error('❌ Gagal membaca file mnemonics.txt.');
        process.exit(1);
    }
}

async function deriveKeypair(mnemonic) {
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

/**
 * Fungsi inti yang menggabungkan seluruh saldo akun ke alamat tujuan.
 */
async function mergeAccount(mnemonic, recipientAddress) {
    let keypair;
    try {
        keypair = await deriveKeypair(mnemonic);
        const senderPublicKey = keypair.publicKey();
        console.log(`🔑 Wallet Pengirim: ${senderPublicKey.substring(0, 10)}...`);

        const account = await server.loadAccount(senderPublicKey);
        const fee = await server.fetchBaseFee();
        const mainBalance = account.balances.find(b => b.asset_type === 'native')?.balance || '0';

        // Cek apakah saldo cukup untuk membayar biaya transaksi merge
        if (parseFloat(mainBalance) < (parseFloat(fee) / 1e7)) {
            console.log(`   ⚠️ Saldo ${mainBalance} Pi tidak cukup untuk membayar biaya transaksi.`);
            return;
        }

        console.log(`   💰 Saldo total yang akan di-merge: ${mainBalance} Pi`);

        // MEMBANGUN TRANSAKSI DENGAN OPERASI accountMerge
        const transaction = new StellarSdk.TransactionBuilder(account, {
            fee: fee,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
        .addOperation(StellarSdk.Operation.accountMerge({
            destination: recipientAddress,
        }))
        .setTimeout(30)
        .build();

        transaction.sign(keypair);

        // Mengirim transaksi langsung ke API Horizon
        console.log("   🚀 Mengirim transaksi AccountMerge...");
        const xdr = transaction.toEnvelope().toXDR('base64');
        const params = new URLSearchParams();
        params.append('tx', xdr);

        const result = await axios.post(`${PI_API}/transactions`, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        const successMsg = `
✅ <b>Akun Berhasil Di-Merge!</b>
<b>Seluruh Saldo (<code>${mainBalance} Pi</code>) telah dikirim.</b>
<b>Dari:</b> <code>${senderPublicKey}</code> (akun ini sekarang non-aktif)
<b>Ke:</b> <code>${recipientAddress}</code>
<a href="https://blockexplorer.minepi.com/mainnet/transactions/${result.data.hash}">Lihat di Explorer</a>
        `.trim();
        console.log(`   ✅ Berhasil! Akun di-merge. Hash: https://blockexplorer.minepi.com/mainnet/transactions/${result.data.hash}`);
        await sendTelegram(successMsg);

    } catch (e) {
        const shortAddress = keypair ? keypair.publicKey().substring(0, 10) : 'unknown';
        const serverError = e.response?.data?.extras?.result_codes?.operations?.[0] || e.response?.data?.title || e.message;
        console.error(`❌ Error pada wallet [${shortAddress}]:`, serverError);
    }
}

async function main() {
    console.log("🚀 Bot Account Merge Pi Dijalankan...");
    const receiverAddress = process.env.RECEIVER_ADDRESS;
    if (!receiverAddress) {
        console.error("❌ Variabel RECEIVER_ADDRESS tidak ditemukan di file .env.");
        return;
    }

    // Validasi penting untuk Account Merge
    if (!receiverAddress.startsWith('G')) {
        console.error("❌ KESALAHAN: Untuk Account Merge, RECEIVER_ADDRESS harus alamat 'G...' standar, bukan 'M...'.");
        console.error("   Silakan perbaiki alamat di file .env Anda.");
        return;
    }

    const mnemonics = loadMnemonics();
    if (mnemonics.length === 0) {
        console.error("❌ Tidak ada mnemonic ditemukan di mnemonics.txt.");
        return;
    }
    console.log(`📚 Ditemukan ${mnemonics.length} wallet untuk di-merge.`);

    for (let i = 0; i < mnemonics.length; i++) {
        console.log("---------------------------------------------------");
        console.log(`[${new Date().toLocaleString()}] Memproses Wallet #${i + 1}/${mnemonics.length}`);
        await mergeAccount(mnemonics[i], receiverAddress);
        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    console.log("---------------------------------------------------");
    console.log("✅ Semua wallet telah selesai diproses.");
}

main();
