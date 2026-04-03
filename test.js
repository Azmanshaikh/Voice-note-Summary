const axios = require('axios');
const API_KEY = 'sk-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';

async function test() {
  try {
    const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama3-8b-8192',
      messages: [{role: 'user', content: 'hello'}]
    }, {
      headers: { Authorization: `Bearer ${API_KEY}` }
    });
    console.log('success chat groq', data.choices[0].message.content);
  } catch (e) {
    console.log('error chat groq', e.response?.data || e.message);
  }
}
test();
