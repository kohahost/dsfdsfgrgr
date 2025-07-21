// stellar-sdk v8.x tidak memerlukan .default
const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
const fs = require('fs');
require("dotenv").config();
const { URLSearchParams } = require('url');

// --- KONFIGURASI ---
const DELAY_BETWEEN_WALLETS_MS = 1000; // Jeda antar pemrosesan wallet (dalam milidetik)
const PI_API_SERVER = 'https://api.mainnet.minepi.com';
const PI_NETWORK_PASSPHRASE = 'Pi Network';
const server = new StellarSdk.Server(PI_API_SERVER);

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
    const derivationPath = "m/44'/314159'/0'";
    const { key } = ed25519.derivePath(derivationPath, seed.toString('hex'));
    const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);
    return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

/**
 * Mengirim transaksi yang sudah ditandatangani langsung tanpa proxy.
 */
async function submitTransactionDirectly(xdr) {
    console.log('📡 Mengirim XDR langsung ke jaringan Pi (tanpa proxy)...');
    try {
        const response = await axios.post(`${PI_API_SERVER}/transactions`, new URLSearchParams({ tx: xdr }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            // Meningkatkan timeout untuk memberi lebih banyak waktu respons dari server Pi
            timeout: 10000 // Diubah dari 3000ms menjadi 10000ms (10 detik)
        });

        console.log(`✅ Transaksi berhasil dengan status: ${response.status}`);
        return response.data;
    } catch (error) {
        // Log respons error lengkap untuk debugging yang lebih baik
        const errDetails = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        console.error(`❌ Gagal mengirim transaksi: ${errDetails}`);
        throw new Error(`Gagal submit transaksi: ${errDetails}`);
    }
}

/**
 * Mengirim semua saldo dari satu wallet ke alamat tujuan menggunakan accountMerge.
 * PENTING: Operasi ini akan MENUTUP dan MENGHAPUS akun pengirim.
 */
async function sendAllAmount(mnemonic, recipient, walletIndex) {
    let wallet;
    try {
        wallet = await getPiWalletAddressFromSeed(mnemonic);
        const senderPublic = wallet.publicKey;
        console.log(`🔑 Memproses Wallet #${walletIndex + 1}: ${senderPublic.substring(0, 10)}...`);

        const account = await server.loadAccount(senderPublic);
        const balanceLine = account.balances.find(b => b.asset_type === 'native');
        const balance = parseFloat(balanceLine.balance);
        console.log(`💰 Saldo terdeteksi: ${balance} Pi`);

        // Untuk accountMerge, kita hanya perlu memastikan ada saldo yang bisa dikirim.
        // Cadangan minimum 1 Pi dan biaya akan otomatis disertakan dalam transfer.
        if (balance <= 0.0000001) { // Hampir nol, tidak ada yang bisa dikirim
            console.log("⚠️ Saldo terlalu rendah untuk di-merge. Melewati...");
            return;
        }

        const feeInStroops = await server.fetchBaseFee();
        // Untuk accountMerge, kita tidak perlu menghitung amountToSend secara eksplisit.
        // Semua saldo akan dikirim, dan biaya akan dipotong dari saldo tersebut.
        console.log(`➡️ Menggabungkan semua saldo (${balance} Pi) ke ${recipient.substring(0, 10)}...`);
        console.log(`   (Biaya transaksi diperkirakan: ${feeInStroops / 1e7} Pi)`);

        let destinationAccount;
        try {
            // Coba parsing sebagai Muxed Account, jika gagal, gunakan sebagai alamat publik standar
            destinationAccount = StellarSdk.MuxedAccount.fromMuxedAccount(recipient);
            console.log(`ℹ️ Tujuan: Muxed Account`);
        } catch (e) {
            destinationAccount = recipient;
            console.log(`ℹ️ Tujuan: Alamat Publik standar`);
        }

        // Membuat transaksi dengan operasi accountMerge
        const tx = new StellarSdk.TransactionBuilder(account, {
            fee: feeInStroops.toString(), // Biaya transaksi
            networkPassphrase: PI_NETWORK_PASSPHRASE
        })
            .addOperation(StellarSdk.Operation.accountMerge({
                destination: destinationAccount,
            }))
            .setTimeout(30) // Timeout transaksi di blockchain (30 detik)
            .build();

        const senderKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
        tx.sign(senderKeypair); // Menandatangani transaksi dengan kunci rahasia pengirim

        // Mengirim transaksi
        const result = await submitTransactionDirectly(tx.toXDR());

        if (result && result.hash) {
            console.log("✅ Transaksi Account Merge Berhasil! Hash:", result.hash);
            const notificationMessage = `
✅ <b>Account Merge Berhasil!</b>

<b>Jumlah Total (termasuk cadangan & fee):</b> <code>${balance} Pi</code>
<b>Akun Sumber (Dihapus):</b> <code>${senderPublic.substring(0, 5)}...${senderPublic.substring(senderPublic.length - 5)}</code>
<b>Akun Tujuan:</b> <code>${recipient.substring(0, 5)}...${recipient.substring(recipient.length - 5)}</code>
<b>Dev: @zendshost</b>

<a href="https://blockexplorer.minepi.com/mainnet/transactions/${result.hash}">Lihat Transaksi</a>`;
            await sendTelegramNotification(notificationMessage.trim());
        } else {
            console.error("❌ GAGAL KONFIRMASI: Tidak ada hash transaksi.");
            await sendTelegramNotification(`❌ <b>Account Merge Gagal!</b> Tidak ada hash transaksi dari wallet ${senderPublic.substring(0, 5)}...`);
        }

    } catch (e) {
        const address = wallet ? wallet.publicKey.substring(0, 10) + '...' : 'unknown';
        let errorMessage = `❌ Error untuk Wallet ${address}: ${e.message || e}`;

        if (e.message?.includes("Format mnemonic tidak valid")) {
            errorMessage = `❌ Error Mnemonic #${walletIndex + 1}: ${e.message}`;
        } else if (e.message?.includes("account not found") || e.response?.status === 404) {
            errorMessage = `❌ Wallet ${address} belum aktif di Mainnet.`;
        } else if (e.message?.includes("tx_insufficient_balance")) {
            errorMessage = `❌ Wallet ${address} tidak cukup saldo untuk biaya transaksi.`;
        } else if (e.message?.includes("tx_no_destination")) {
            errorMessage = `❌ Alamat tujuan (${recipient.substring(0, 10)}...) belum aktif di Mainnet.`;
        } else if (e.message?.includes("tx_bad_auth")) {
            errorMessage = `❌ Gagal otentikasi transaksi. Pastikan kunci rahasia dan network passphrase benar.`;
        } else if (e.message?.includes("op_has_subentries")) {
            errorMessage = `❌ Akun ${address} memiliki trustline atau penawaran aktif. Tidak bisa di-merge.`;
        }

        console.error(errorMessage);
        await sendTelegramNotification(`❌ <b>Account Merge Gagal!</b> dari wallet ${address}\n\nDetail: ${errorMessage}`);
    }
}

let walletIndex = 0;
async function main() {
    console.log("🚀 Memulai Bot Pengirim Saldo Pi (Mode Account Merge)...");
    console.log("⚠️ PERINGATAN: Bot ini akan MENGHAPUS akun sumber setelah transfer semua saldo.");

    const mnemonics = loadMnemonics();
    const recipient = process.env.RECEIVER_ADDRESS;

    // Penting: Pastikan RECEIVER_ADDRESS sudah aktif di Pi Mainnet
    // (sudah menerima setidaknya 1 Pi sebelumnya)
    if (!recipient || (!recipient.startsWith('G') && !recipient.startsWith('M'))) {
        console.error("❌ Error: RECEIVER_ADDRESS tidak valid. Harus dimulai dengan 'G' atau 'M'.");
        return;
    }

    if (mnemonics.length === 0) {
        console.error("❌ Tidak ada mnemonic ditemukan.");
        return;
    }

    console.log(`✔️ ${mnemonics.length} wallet dimuat.`);
    console.log(`🎯 Tujuan: ${recipient}`);
    console.log("__________________________________________________________________");

    while (true) {
        const mnemonic = mnemonics[walletIndex];

        console.log(`\n[${new Date().toLocaleString('id-ID')}] Memproses Wallet #${walletIndex + 1}/${mnemonics.length}`);
        // Memanggil fungsi sendAllAmount yang menggunakan accountMerge
        await sendAllAmount(mnemonic, recipient, walletIndex);
        console.log("__________________________________________________________________");

        walletIndex = (walletIndex + 1) % mnemonics.length;
        if (walletIndex === 0) {
            console.log(`\n🔄 Semua wallet telah diproses. Ulangi setelah ${DELAY_BETWEEN_WALLETS_MS / 1000} detik...\n`);
        }

        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_WALLETS_MS));
    }
}

main();
