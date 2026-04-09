const express = require('express');
const cors = require('cors');
const https = require('https');

// ── Load env vars (works locally without dotenv on Railway/Render) ──
try { require('dotenv').config({ override: true }); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const APP_SECRET = process.env.APP_SECRET;
const MODEL = 'claude-sonnet-4-20250514';

app.use(cors());
app.use(express.json({ limit: '10mb' })); // large for base64 images

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'VIN AI API' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Auth middleware ──
function checkAppSecret(req, res, next) {
  const secret = req.headers['x-app-secret'];
  if (secret !== APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Decode VIN ──
app.post('/api/decode-vin', checkAppSecret, async (req, res) => {
  try {
    const { vin } = req.body;
    if (!vin) return res.status(400).json({ error: 'VIN is required' });

    const prompt = `Decode this VIN and return ONLY valid JSON, no markdown or backticks.
VIN: ${vin}

Return: {"year":"","make":"","model":"","trim":"","engine":"engine description with displacement and cylinders"}

If invalid return: {"error":"Could not decode this VIN"}`;

    const data = await callClaude(prompt, 500);
    const parsed = parseJSON(data);

    if (parsed.error || !parsed.make || !parsed.model) {
      return res.status(400).json({ error: parsed.error || 'Could not decode VIN' });
    }

    res.json({
      year: parsed.year,
      make: parsed.make,
      model: parsed.model,
      trim: parsed.trim || 'Base',
      engine: parsed.engine || 'Standard',
    });
  } catch (e) {
    console.error('decode-vin error:', e.message, e.stack);
    res.status(500).json({ error: 'Failed to decode VIN' });
  }
});

// ── Search Parts ──
app.post('/api/search-parts', checkAppSecret, async (req, res) => {
  try {
    const { vehicle, query } = req.body;
    if (!vehicle || !query) return res.status(400).json({ error: 'Vehicle and query are required' });

    const prompt = `You are an expert automotive parts advisor. Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim} (engine: ${vehicle.engine}). Part needed: "${query}".

Return ONLY valid JSON (no markdown, no backticks, no explanation):
{
  "parts": [
    {
      "part_name": "specific part name",
      "brand": "brand name",
      "tier": "OEM" | "Aftermarket Premium" | "Aftermarket Budget" | "Value",
      "estimated_price_range": "$XX - $XX",
      "where_to_get": "eBay, Car-Part.com, or Amazon",
      "availability": "In stock" | "1-3 days" | "1 week+",
      "buy_now_vs_wait": number 1-10 (10=most urgent),
      "buy_now_explanation": "one sentence",
      "compatibility_note": "fitment confirmation for this vehicle",
      "diy_difficulty": "Easy" | "Moderate" | "Advanced" | "Pro Only",
      "diy_time_estimate": "e.g. 30 min, 1-2 hours",
      "estimated_labor_cost": "$XX - $XX at a shop"
    }
  ],
  "best_pick_index": 0,
  "overall_recommendation": "2-3 sentences on the best choice and why",
  "part_location_description": "where this part sits on the vehicle"
}

Provide 3-4 options mixing OEM, aftermarket premium, and budget tiers. For where_to_get, ONLY recommend: eBay, Car-Part.com (for used/salvage OEM parts), or Amazon. Factor in safety criticality, price differences, and lead times. Be specific to this exact trim and engine.`;

    const data = await callClaude(prompt, 1500);
    res.json(parseJSON(data));
  } catch (e) {
    console.error('search-parts error:', e.message);
    res.status(500).json({ error: 'Failed to search parts' });
  }
});

// ── OCR VIN from image ──
app.post('/api/ocr-vin', checkAppSecret, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Image is required' });

    const messages = [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: image },
        },
        {
          type: 'text',
          text: `Look at this image and find the Vehicle Identification Number (VIN). A VIN is exactly 17 characters long, containing uppercase letters (except I, O, Q) and digits.

Return ONLY valid JSON (no markdown, no backticks):
{"vin": "THE17CHARVINHERE0", "confidence": "high" | "medium" | "low"}

If you cannot find a VIN, return: {"vin": null, "error": "Could not find a VIN in this image"}`,
        },
      ],
    }];

    const data = await callClaudeRaw(messages, 200);
    res.json(parseJSON(data));
  } catch (e) {
    console.error('ocr-vin error:', e.message);
    res.status(500).json({ error: 'Failed to read VIN from image' });
  }
});

// ── Assess Damage ──
app.post('/api/assess-damage', checkAppSecret, async (req, res) => {
  try {
    const { image, vehicle } = req.body;
    if (!image) return res.status(400).json({ error: 'Image is required' });

    const vehicleInfo = vehicle
      ? `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}`
      : 'Unknown vehicle';

    const messages = [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: image },
        },
        {
          type: 'text',
          text: `You are an expert automotive damage assessor. This photo is of a ${vehicleInfo}.

Analyze the visible damage and return ONLY valid JSON (no markdown, no backticks):
{
  "damage_summary": "2-3 sentence overview of what you see",
  "severity": "Minor" | "Moderate" | "Severe" | "Total Loss",
  "severity_score": number 1-10,
  "damaged_parts": [
    {
      "part_name": "name of damaged part",
      "damage_description": "what's wrong with it",
      "repair_or_replace": "Repair" | "Replace",
      "estimated_part_cost": "$XX - $XX",
      "estimated_labor_cost": "$XX - $XX",
      "urgency": "Cosmetic" | "Drive with caution" | "Do not drive"
    }
  ],
  "safety_concerns": ["list of any safety issues to be aware of"],
  "recommended_next_steps": ["ordered list of what to do next"],
  "driveable": true | false,
  "estimated_total_repair": "$XX - $XX"
}

Be thorough but realistic. If you cannot clearly see damage, note what's visible and what you'd need a closer look at.`,
        },
      ],
    }];

    const data = await callClaudeRaw(messages, 2000);
    res.json(parseJSON(data));
  } catch (e) {
    console.error('assess-damage error:', e.message);
    res.status(500).json({ error: 'Failed to assess damage' });
  }
});

// ── Claude API helpers ──
function callClaude(prompt, maxTokens) {
  const messages = [{ role: 'user', content: prompt }];
  return callClaudeRaw(messages, maxTokens);
}

function callClaudeRaw(messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages,
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Anthropic API error ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.map(b => b.text || '').join('') || '';
          resolve(text);
        } catch (e) {
          reject(new Error('Failed to parse Anthropic response'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ── Start server ──
app.listen(PORT, () => {
  console.log(`VIN AI server running on port ${PORT}`);
});
