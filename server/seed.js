const db = require('./db');

const PRODUCTS = [
  { sku: 'STEAM-TOPUP-500', name: 'Пополнение Steam 500 ₽', type: 'topup', price: 500, currency: 'RUB', image: 'assets/steam.png' },
  { sku: 'STEAM-TOPUP-1000', name: 'Пополнение Steam 1000 ₽', type: 'topup', price: 1000, currency: 'RUB', image: 'assets/steam.png' },
  { sku: 'STEAM-TOPUP-2500', name: 'Пополнение Steam 2500 ₽', type: 'topup', price: 2500, currency: 'RUB', image: 'assets/steam.png' },
  { sku: 'KEY-CS2-PRIME', name: 'CS2 Prime Status ключ', type: 'key', price: 1290, currency: 'RUB', image: 'assets/cs2.png' },
  { sku: 'KEY-GTA5', name: 'GTA V ключ активации', type: 'key', price: 1990, currency: 'RUB', image: 'assets/gta5.png' },
  { sku: 'KEY-EFT', name: 'Escape from Tarkov ключ', type: 'key', price: 3490, currency: 'RUB', image: 'assets/eft.png' },
  { sku: 'SUB-DISCORD-1M', name: 'Discord Nitro 1 месяц', type: 'subscription', price: 399, currency: 'RUB', image: 'assets/discord.png' },
  { sku: 'SUB-YT-3M', name: 'YouTube Premium 3 месяца', type: 'subscription', price: 1490, currency: 'RUB', image: 'assets/youtube.png' },
  { sku: 'SUB-SPOTIFY-1M', name: 'Spotify Premium 1 месяц', type: 'subscription', price: 299, currency: 'RUB', image: 'assets/spotify.png' },
  { sku: 'GIFT-PSN-1000', name: 'PlayStation Store карта 1000 ₽', type: 'giftcard', price: 1000, currency: 'RUB', image: 'assets/psn.png' },
  { sku: 'GIFT-XBOX-1500', name: 'Xbox Gift Card 1500 ₽', type: 'giftcard', price: 1500, currency: 'RUB', image: 'assets/xbox.png' },
  { sku: 'GIFT-ROBLOX-800', name: 'Roblox 800 Robux', type: 'giftcard', price: 890, currency: 'RUB', image: 'assets/roblox.png' },
];

const KEYS = [
  'LFXC-TNCS-BPCD', 'P3EI-W8UO-9B4K', 'FEL3-GUXN-TCCH', 'YPLV-QK2Z-IUS5',
  '0K9E-P1FR-BY1U', '5LZV-UQ48-RXCZ', 'X93K-NYAQ-GEC1', 'EIO5-CQT5-35KO',
  'M58F-GIIR-VJAP', 'NU8Y-SWYB-6252', 'OODW-CCHF-MBAF', 'DNA5-WFJM-NE49',
  'QRDD-MJ3F-A8TF', 'TAT9-5ZJN-G1T2', 'LI39-4330-ISMB', 'BKJY-8Q79-8NHI',
  'HHW6-4RX2-DX62', '1RG2-L28O-O80G', 'EF63-F39X-MTEA', '8XS7-P53H-JKIV',
  'JPE6-MQV6-P7ST', 'SAPG-A2GR-0ULS', 'T2DU-IJ1S-U16P', 'WSSY-QTR7-Z57J',
  'U74E-EPCI-CY26', 'FZXF-58H8-OR93', 'FPSM-HLZA-TPAL', 'WSC9-28DJ-B2JE',
  'P63J-F7UZ-DCYP', 'C7W2-D4C5-QMT7', 'JESI-DFBH-LK1K', 'SGMA-JA0T-GR7D',
  '3PR4-OSY9-M3ZW', 'OMBE-C0JF-D45Y', 'KIKQ-FQJ8-9TI8', 'LMAN-RSHS-AJDO',
  'BAKI-VT1X-Z5OL', '9F0X-B46W-03FS', 'S423-V6YY-IBEM', 'D4UW-WYRA-20ST',
  'XC0J-CJ0H-09RN', 'RY1W-XCFJ-0KUA', 'CJYY-YKSQ-QE6H', '97AQ-38QJ-H8HU',
  'FS8E-3S5Z-I6RA', 'ARQK-FML4-A14E', '7Z6K-NO9V-MPJB', 'D4K7-IJSG-N853',
  'W67T-ZB0Q-1XKB', '7EQM-K09J-XKUO',
];

function seed() {
  const insertProduct = db.prepare(
    'INSERT OR IGNORE INTO products (sku, name, type, price, currency, image) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const p of PRODUCTS) {
    insertProduct.run(p.sku, p.name, p.type, p.price, p.currency, p.image);
  }

  const insertKey = db.prepare('INSERT OR IGNORE INTO keys (code, status) VALUES (?, \'available\')');
  for (const code of KEYS) {
    insertKey.run(code);
  }

  const productCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  const keyCount = db.prepare('SELECT COUNT(*) AS n FROM keys').get().n;
  console.log(`Seed OK: products=${productCount}, keys=${keyCount}`);
}

seed();
