const express = require('express');
const cors = require('cors');
const https = require('https');

// ── Load env vars (works locally without dotenv on Railway/Render) ──
// Load .env file for local dev (Render/Railway set env vars natively)
try {
  const fs = require('fs');
  if (fs.existsSync('.env')) {
    require('dotenv').config({ override: true });
  }
} catch (_) {}

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

// ── NHTSA VIN Decoder (free, accurate, government data) ──
function decodeVinNHTSA(vin) {
  return new Promise((resolve, reject) => {
    https.get(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${vin}?format=json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const results = {};
          const fields = {
            'Make': 'make',
            'Model': 'model',
            'Model Year': 'year',
            'Trim': 'trim',
            'Engine Number of Cylinders': 'cylinders',
            'Displacement (L)': 'displacement',
            'Fuel Type - Primary': 'fuel_type',
            'Drive Type': 'drive_type',
            'Body Class': 'body_class',
            'Vehicle Type': 'vehicle_type',
            'Turbo': 'turbo',
            'Engine Model': 'engine_model',
          };
          parsed.Results?.forEach(r => {
            if (fields[r.Variable] && r.Value && r.Value.trim()) {
              results[fields[r.Variable]] = r.Value.trim();
            }
          });
          resolve(results);
        } catch (e) {
          reject(new Error('Failed to parse NHTSA response'));
        }
      });
    }).on('error', reject);
  });
}

// ── Decode VIN ──
app.post('/api/decode-vin', checkAppSecret, async (req, res) => {
  try {
    const { vin } = req.body;
    if (!vin) return res.status(400).json({ error: 'VIN is required' });

    // Step 1: Get OFFICIAL data from NHTSA (free government API)
    let nhtsa = {};
    try {
      nhtsa = await decodeVinNHTSA(vin);
    } catch (e) {
      console.error('NHTSA fallback:', e.message);
    }

    // If NHTSA gave us solid data, build the response from it
    if (nhtsa.make && nhtsa.model && nhtsa.year) {
      // Build engine string from NHTSA data
      const displacement = nhtsa.displacement ? `${nhtsa.displacement}L` : '';
      const cylConfig = nhtsa.cylinders ? (parseInt(nhtsa.cylinders) <= 4 ? `I${nhtsa.cylinders}` : parseInt(nhtsa.cylinders) === 6 ? 'V6' : `V${nhtsa.cylinders}`) : '';
      const turbo = nhtsa.turbo === 'Yes' ? ' Turbo' : '';
      const fuelType = nhtsa.fuel_type || 'Gasoline';
      const engine = `${displacement} ${cylConfig}${turbo} ${fuelType}`.trim();

      return res.json({
        year: nhtsa.year,
        make: nhtsa.make.charAt(0).toUpperCase() + nhtsa.make.slice(1).toLowerCase(),
        model: nhtsa.model,
        trim: nhtsa.trim || 'Base',
        engine: engine || 'Standard',
        fuel_type: fuelType,
        drive_type: nhtsa.drive_type || '',
        body_class: nhtsa.body_class || '',
      });
    }

    // Step 2: Fallback to AI if NHTSA doesn't have the data
    const prompt = `You are an expert VIN decoder. Decode this VIN: ${vin}

Return ONLY valid JSON, no markdown or backticks:
{"year":"","make":"","model":"","trim":"","engine":"displacement + configuration + fuel type","fuel_type":"Gasoline|Diesel|Hybrid|Electric|Flex Fuel"}

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
      fuel_type: parsed.fuel_type || 'Gasoline',
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
      "part_number": "exact manufacturer part number (e.g. Wagner QC1400, Motorcraft FA-1927, Bosch 9617, ACDelco 41-110)",
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

CRITICAL: You MUST include a real, accurate part_number for every part. Use the actual manufacturer/brand part number that someone could search on Amazon, AutoZone, or eBay to find the exact product. Do NOT make up part numbers — use real ones.

Provide 3-4 options mixing OEM, aftermarket premium, and budget tiers. Factor in safety criticality, price differences, and lead times. Be specific to this exact trim and engine.`;

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

// ── Maintenance Schedule ──
app.post('/api/maintenance', checkAppSecret, async (req, res) => {
  try {
    const { vehicle, mileage } = req.body;
    if (!vehicle || !mileage) return res.status(400).json({ error: 'Vehicle and mileage are required' });

    const vehicleInfo = `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim} (engine: ${vehicle.engine}${vehicle.fuel_type ? ', ' + vehicle.fuel_type : ''})`;
    const currentMileage = parseInt(mileage);

    const prompt = `You are an expert automotive maintenance advisor with access to manufacturer service manuals. Vehicle: ${vehicleInfo}. Current mileage: ${currentMileage.toLocaleString()} miles.

IMPORTANT INSTRUCTIONS:
1. Use the ACTUAL manufacturer-recommended service intervals from ${vehicle.make}'s owner's manual for this EXACT year, model, trim, and engine. Do NOT use generic intervals.
2. For example: if ${vehicle.make} recommends oil changes every 10,000 miles for this engine, use 10,000 — NOT 5,000 or 3,000.
3. Calculate "last_due_miles" and "next_due_miles" based on the manufacturer interval. Example: if interval is 10,000 miles and current mileage is 87,000, then last_due is 80,000 and next_due is 90,000.
4. Be HONEST with statuses. Only mark "overdue" if the current mileage has genuinely passed the next service milestone. Don't inflate urgency to scare users.
5. If this is a DIESEL vehicle, include diesel-specific items (DEF fluid, fuel filter, glow plugs, turbo, etc.) with their correct diesel intervals.
6. If this is a GASOLINE vehicle, do NOT include diesel-specific items.

Return ONLY valid JSON (no markdown, no backticks):
{
  "vehicle_summary": "${vehicle.year} ${vehicle.make} ${vehicle.model} — ${vehicle.engine}",
  "current_mileage": ${currentMileage},
  "source": "Based on ${vehicle.make} recommended maintenance schedule",
  "items": [
    {
      "service": "name of service",
      "interval_miles": manufacturer recommended interval in miles,
      "interval_months": manufacturer recommended interval in months,
      "last_due_miles": last milestone this was due,
      "next_due_miles": next milestone this is due,
      "miles_remaining": next_due_miles minus current mileage (negative if overdue),
      "status": "overdue" | "due_soon" | "good",
      "urgency": 1-10,
      "estimated_cost": "$XX - $XX (parts + labor at a shop)",
      "diy_difficulty": "Easy" | "Moderate" | "Advanced" | "Pro Only",
      "description": "why this service matters for THIS specific vehicle",
      "category": "Engine" | "Transmission" | "Brakes" | "Fluids" | "Filters" | "Tires" | "Electrical" | "Suspension" | "Exhaust" | "Other"
    }
  ],
  "health_tips": ["2-3 actionable tips specific to a ${vehicle.year} ${vehicle.make} ${vehicle.model} at ${currentMileage.toLocaleString()} miles"]
}

Include 12-18 items. Sort by urgency (most urgent first). Mark items as:
- "overdue" ONLY if current mileage has passed the next_due_miles
- "due_soon" if within 3,000 miles of next service
- "good" if not due yet

ACCURACY IS CRITICAL. Users will compare this against their owner's manual. If intervals are wrong, they will not trust the app.`;

    const data = await callClaude(prompt, 3000);
    res.json(parseJSON(data));
  } catch (e) {
    console.error('maintenance error:', e.message);
    res.status(500).json({ error: 'Failed to generate maintenance schedule' });
  }
});

// ── Diagnose Symptom ──
app.post('/api/diagnose', checkAppSecret, async (req, res) => {
  try {
    const { vehicle, symptom } = req.body;
    if (!vehicle || !symptom) return res.status(400).json({ error: 'Vehicle and symptom are required' });

    const vehicleInfo = `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim} (engine: ${vehicle.engine}${vehicle.fuel_type ? ', ' + vehicle.fuel_type : ''})`;

    const prompt = `You are an expert automotive diagnostician. Vehicle: ${vehicleInfo}. The owner reports: "${symptom}".

Based on this EXACT vehicle and the described symptom, diagnose the most likely causes.

Return ONLY valid JSON (no markdown, no backticks):
{
  "symptom_summary": "restated symptom in technical terms",
  "urgency": "Low" | "Medium" | "High" | "Critical",
  "urgency_score": 1-10,
  "driveable": true | false,
  "causes": [
    {
      "cause": "name of the likely cause",
      "likelihood": "Very Likely" | "Likely" | "Possible",
      "explanation": "2-3 sentences on why this happens on this specific vehicle",
      "parts_needed": ["list of parts that may need replacing"],
      "estimated_repair_cost": "$XX - $XX",
      "diy_difficulty": "Easy" | "Moderate" | "Advanced" | "Pro Only",
      "diy_possible": true | false,
      "time_estimate": "e.g. 1-2 hours",
      "what_happens_if_ignored": "consequence of not fixing"
    }
  ],
  "quick_checks": ["things the owner can check right now at home"],
  "recommendation": "2-3 sentences of overall advice for this specific situation"
}

Provide 3-5 causes ordered by likelihood (most likely first). Be specific to THIS vehicle — mention known common issues for this year/make/model if applicable. Be honest about DIY feasibility.`;

    const data = await callClaude(prompt, 2500);
    res.json(parseJSON(data));
  } catch (e) {
    console.error('diagnose error:', e.message);
    res.status(500).json({ error: 'Failed to diagnose symptom' });
  }
});

// ── Claude API helpers ──
function callClaude(prompt, maxTokens) {
  const messages = [{ role: 'user', content: prompt }];
  return callClaudeRaw(messages, maxTokens);
}

function callClaudeRaw(messages, maxTokens, retries = 3) {
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
        // Retry on overloaded (529) or server errors (500+)
        if ((res.statusCode === 529 || res.statusCode >= 500) && retries > 0) {
          const delay = (4 - retries) * 2000; // 2s, 4s, 6s
          setTimeout(() => {
            callClaudeRaw(messages, maxTokens, retries - 1).then(resolve).catch(reject);
          }, delay);
          return;
        }
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

// ── Keep-alive ping (prevents Render free tier from sleeping) ──
setInterval(() => {
  https.get('https://vinai-server.onrender.com/health', () => {});
}, 14 * 60 * 1000); // ping every 14 minutes

// ── Start server ──
app.listen(PORT, () => {
  console.log(`VIN AI server running on port ${PORT}`);
});
