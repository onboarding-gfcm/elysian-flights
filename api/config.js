module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    siteName: process.env.SITE_NAME || 'Élysian Flights',
    whatsappNumber: process.env.WHATSAPP_NUMBER || '31639027470',
    currencySymbol: process.env.CURRENCY_SYMBOL || '€',
  });
};
