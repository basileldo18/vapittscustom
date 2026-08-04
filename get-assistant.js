require('dotenv').config();
const https = require('https');
const fs = require('fs');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID = '1220b768-474a-4c26-9f94-d9b6d144b83d';

const options = {
    hostname: 'api.vapi.ai',
    port: 443,
    path: `/assistant/${ASSISTANT_ID}`,
    method: 'GET',
    headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`
    }
};

const req = https.request(options, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => {
        try {
            const assistant = JSON.parse(d);
            fs.writeFileSync('current_live_assistant.json', JSON.stringify(assistant, null, 2));
            console.log('Saved live assistant to current_live_assistant.json');
        } catch (e) {
            console.log('Error parsing response:', e);
            fs.writeFileSync('current_live_assistant.json', d);
        }
    });
});

req.on('error', (err) => console.log('HTTP request error:', err));
req.end();
