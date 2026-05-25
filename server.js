const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('HKJC bridge is running');
});

app.get('/odds', (req, res) => {
  res.json({
    ok: true,
    message: 'odds route works',
    query: req.query
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ HKJC bridge running on port ${PORT}`);
});
