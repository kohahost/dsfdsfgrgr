// Menggunakan stellar-sdk v8.x, jadi TIDAK perlu .default
const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
const fs = require('fs');
require("dotenv").config();

// --- KONFIGURASI ---
const DELAY_BETWEEN_WALLETS_MS = 1000;
const PI_API_SERVER = 'https://api.mainnet.minepi.com';
const PI_NETWORK_PASSPHRASE = 'Pi Network';
const server = new StellarSdk.Server(PI_API_SERVER);

async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.warn("⚠️  Variabel Telegram (TOKEN/CHAT_ID) belum diatur di file .env. Notifikasi dilewati.");
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

function loadMnemonics() {
    try {
        const data = fs.readFileSync('mnemonics.txt', 'utf8');
        return data.split(/\r?\n/).filter(line => line.trim() !== '');
    } catch (err) {
        console.error('❌ Error: Tidak dapat membaca file mnemonics.txt. Pastikan file tersebut ada.');
        process.exit(1);
    }
}

async function getPiWalletAddressFromSeed(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("Format mnemonic tidak valid (salah kata atau jumlah).");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const derivationPath = "m/44'/314159'/0'";
    const { key } = ed25519.derivePath(derivationPath, seed.toString('hex'));
    const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);
    return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

async function sendMaxAmount(mnemonic, recipient) {
    let wallet;
    try {
        wallet = await getPiWalletAddressFromSeed(mnemonic);
        const senderPublic = wallet.publicKey;
        console.log(`🔑 Memproses Wallet: ${senderPublic.substring(0, 10)}...`);

        const account = await server.loadAccount(senderPublic);
        const balanceLine = account.balances.find(b => b.asset_type === 'native');
        const balance = parseFloat(balanceLine.balance);
        console.log(`💰 Saldo terdeteksi: ${balance} Pi`);

        if (balance < 1.01) {
            console.log("⚠️ Saldo di bawah 1.01 Pi. Tidak cukup untuk cadangan minimum & biaya. Melewati...");
            return;
        }

        const feeInStroops = await server.fetchBaseFee();
        const amountToSend = balance - 1 - (feeInStroops / 1e7);

        if (amountToSend <= 0) {
            console.log("⚠️ Tidak ada saldo yang bisa dikirim di atas cadangan minimum. Melewati...");
            return;
        }

        const formattedAmount = amountToSend.toFixed(7);

        // ✅ DETEKSI ALAMAT TUJUAN
        let destination;
        let recipientDisplay;
        if (recipient.startsWith("M")) {
            destination = StellarSdk.MuxedAccount.fromAddress(recipient);
            recipientDisplay = destination.baseAccount();
        } else {
            destination = recipient;
            recipientDisplay = recipient;
        }

        console.log(`➡️ Mengirim: ${formattedAmount} Pi ke ${recipientDisplay.substring(0, 10)}...`);

        const tx = new StellarSdk.TransactionBuilder(account, {
            fee: feeInStroops.toString(),
            networkPassphrase: PI_NETWORK_PASSPHRASE
        })
            .addOperation(StellarSdk.Operation.payment({
                destination,
                asset: StellarSdk.Asset.native(),
                amount: formattedAmount.toString(),
            }))
            .setTimeout(30)
            .build();

        const senderKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
        tx.sign(senderKeypair);

        const result = await server.submitTransaction(tx);

        if (result && result.hash) {
            console.log("✅ Transaksi Berhasil! Saldo telah dikirim. Hash:", result.hash);
            const notificationMessage = `
✅ <b>Transfer Berhasil!</b>

<b>Jumlah:</b> <code>${formattedAmount} Pi</code>
<b>Dari:</b> <code>${senderPublic.substring(0, 5)}...${senderPublic.substring(senderPublic.length - 5)}</code>
<b>Ke:</b> <code>${recipientDisplay.substring(0, 5)}...${recipientDisplay.substring(recipientDisplay.length - 5)}</code>

<a href="https://blockexplorer.minepi.com/mainnet/transactions/${result.hash}">Lihat Transaksi</a>`;
            await sendTelegramNotification(notificationMessage.trim());
        } else {
            console.error("❌ GAGAL KONFIRMASI: Server tidak mengembalikan hash transaksi yang valid.");
        }

    } catch (e) {
        const address = wallet ? wallet.publicKey.substring(0, 10) + '...' : 'unknown';
        if (e.message && e.message.includes("Format mnemonic tidak valid")) {
            console.error(`❌ Error untuk Mnemonic #${walletIndex + 1}: ${e.message}`);
        } else if (e.response && e.response.status === 404) {
            console.error(`❌ GAGAL: Wallet ${address} tidak ditemukan/belum diaktifkan di Mainnet.`);
        } else if (e.response?.data?.extras?.result_codes?.transaction === 'tx_insufficient_balance') {
            console.error(`❌ GAGAL: Wallet ${address} tidak memiliki saldo yang cukup untuk biaya transaksi.`);
        } else {
            console.error(`❌ Error Umum untuk Wallet ${address}:`, e.message || e);
        }
    }
}

let walletIndex = 0;
async function main() {
    console.log("🚀 Memulai Bot Pengirim Saldo Pi...");
    console.log("ℹ️ Bot ini akan mencoba mengirim saldo di atas 1 Pi dari setiap wallet.");

    const mnemonics = loadMnemonics();
    const recipient = process.env.RECEIVER_ADDRESS;

    if (!recipient || (!recipient.startsWith('G') && !recipient.startsWith('M'))) {
        console.error("❌ Error: RECEIVER_ADDRESS tidak valid atau tidak ditemukan di file .env.");
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

        console.log(`\n[${new Date().toLocaleString()}] Memproses Wallet #${walletIndex + 1}/${mnemonics.length}`);
        await sendMaxAmount(mnemonic, recipient);
        console.log("-------------------------------------------------------------------------------------");

        walletIndex = (walletIndex + 1) % mnemonics.length;
        if (walletIndex === 0) {
            console.log("\n🔄 Semua wallet telah diproses. Mengulang dari awal setelah jeda...\n");
        }

        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_WALLETS_MS));
    }
}

main();
