const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;
const indexPath = path.join(__dirname, 'public', 'index.html');

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

function sendCalendar(req, res) {
  let html = fs.readFileSync(indexPath, 'utf8');

  html = html
    .replace('--row:23px;', '--row:29px;')
    .replace(':root{--row:27px}', ':root{--row:33px}')
    .replace(
      '.appt strong{\n      display:block;\n      font-size:11px;\n      line-height:14px;',
      '.appt strong{\n      display:block;\n      font-size:13px;\n      line-height:16px;'
    )
    .replace(
      '.appt small{\n      display:block;\n      margin-top:1px;\n      font-size:9px;\n      line-height:11px;\n      white-space:nowrap;\n      overflow:hidden;\n      text-overflow:ellipsis;\n      opacity:.96;\n    }',
      '.appt small{display:none}'
    )
    .replace(
      "      const detail=[a.phone,a.reason].filter(Boolean).join(' · ');\n      b.innerHTML=`<strong>${escapeHtml(a.patient)}</strong><small>${a.time}${detail?' · '+escapeHtml(detail):''}</small>`;",
      "      b.innerHTML=`<strong>${escapeHtml(a.patient)}</strong>`;"
    )
    .replace(
      '</head>',
      `<style id="schedule-spacing-fix">
        .time{
          top:50% !important;
          transform:translateY(-50%);
          line-height:1 !important;
          padding:0 0 0 7px !important;
        }
        .slot.hour .time{
          top:50% !important;
          transform:translateY(-50%);
          line-height:1 !important;
        }
      </style></head>`
    );

  res.type('html').send(html);
}

app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/', sendCalendar);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: false }));
app.use(sendCalendar);

app.listen(port, '0.0.0.0', () => {
  console.log(`Medical Calendar listening on port ${port}`);
});
