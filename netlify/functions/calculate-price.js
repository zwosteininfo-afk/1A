const crypto = require('crypto');
const https = require('https');

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function generateOAuthHeader(url, method, params, credentials) {
  const oauthParams = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.tokenValue,
    oauth_version: '1.0'
  };

  const allParams = { ...params, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map(key => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
    .join('&');

  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.tokenSecret)}`;
  
  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  oauthParams.oauth_signature = signature;

  return 'OAuth ' + Object.keys(oauthParams)
    .sort()
    .map(key => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
    .join(', ');
}

function fetchBrickLink(url, credentials) {
  return new Promise((resolve, reject) => {
    const authHeader = generateOAuthHeader(url, 'GET', {}, credentials);
    const options = {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'ZwoStein-Ankauf'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log(`BrickLink Status für ${url}:`, res.statusCode);
        console.log(`BrickLink Body:`, data);
        try {
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: json });
        } catch (e) {
          console.error('JSON Parse Fehler:', data);
          reject(new Error('Ungültige JSON-Antwort von BrickLink'));
        }
      });
    }).on('error', err => {
      console.error('Netzwerkfehler:', err);
      reject(err);
    });
  });
}

const BASE_FACTORS = {
  new: {
    sealed_light_wear: 0.500,         
    sealed_heavy_wear: 0.470,         
    sealed_damaged: 0.430,            
    opened_bags_light_wear: 0.470,    
    opened_bags_heavy_wear: 0.440,    
    opened_bags_damaged: 0.400        
  },
  used: {
    no_instructions_no_box_light: 0.325,  
    no_instructions_no_box_medium: 0.306, 
    no_instructions_no_box_heavy: 0.278,  
    with_instructions_no_box_light: 0.334, 
    with_instructions_no_box_medium: 0.317, 
    with_instructions_no_box_heavy: 0.286,  
    no_instructions_with_box_light: 0.332,  
    no_instructions_with_box_medium: 0.312, 
    no_instructions_with_box_heavy: 0.284,  
    with_instructions_and_box_light: 0.343, 
    with_instructions_and_box_medium: 0.323, 
    with_instructions_and_box_heavy: 0.293  
  }
};

exports.handler = async (event) => {
  const queryParams = event.queryStringParameters || {};
  const setNumber = queryParams.set;

  if (!setNumber) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Bitte eine Set-Nummer angeben." })
    };
  }

  const itemNo = setNumber.includes('-') ? setNumber : `${setNumber}-1`;
  const credentials = {
    consumerKey: process.env.BL_CONSUMER_KEY,
    consumerSecret: process.env.BL_CONSUMER_SECRET,
    tokenValue: process.env.BL_TOKEN_VALUE,
    tokenSecret: process.env.BL_TOKEN_SECRET
  };

  let bricklinkNewAvg = 0;
  let bricklinkUsedAvg = 0;
  let legoSetName = `LEGO® Set ${setNumber}`; 

  try {
    const urlUsed = `https://api.bricklink.com/api/v1/items/SET/${itemNo}/price?new_or_used=U&guide_type=sold&currency_code=EUR&country_code=DE`;
    const urlNew = `https://api.bricklink.com/api/v1/items/SET/${itemNo}/price?new_or_used=N&guide_type=sold&currency_code=EUR&country_code=DE`;

    const [usedRes, newRes] = await Promise.all([
      fetchBrickLink(urlUsed, credentials).catch(err => ({ error: err.message })),
      fetchBrickLink(urlNew, credentials).catch(err => ({ error: err.message }))
    ]);

    if (usedRes && usedRes.statusCode === 200 && usedRes.data && usedRes.data.meta && usedRes.data.meta.code === 200) {
      bricklinkUsedAvg = parseFloat(usedRes.data.data.avg_price) || 0;
      if (usedRes.data.data.item && usedRes.data.data.item.name) {
        legoSetName = usedRes.data.data.item.name;
      }
    }

    if (newRes && newRes.statusCode === 200 && newRes.data && newRes.data.meta && newRes.data.meta.code === 200) {
      bricklinkNewAvg = parseFloat(newRes.data.data.avg_price) || 0;
      if (newRes.data.data.item && newRes.data.data.item.name && legoSetName.startsWith("LEGO® Set")) {
        legoSetName = newRes.data.data.item.name;
      }
    }

    if (bricklinkUsedAvg === 0 && bricklinkNewAvg === 0) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: `Set ${setNumber} auf BrickLink nicht gefunden oder API-Zugriff verweigert.` })
      };
    }

    if (bricklinkNewAvg === 0) bricklinkNewAvg = bricklinkUsedAvg * 1.5;
    if (bricklinkUsedAvg === 0) bricklinkUsedAvg = bricklinkNewAvg / 1.5;

  } catch (error) {
    console.error('Handler Fehler:', error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Fehler beim Abrufen der BrickLink-Daten.", details: error.message })
    };
  }

  let tierMultiplier = 1.0;
  let detectedTier = "Standard";

  if (bricklinkUsedAvg < 50) {
    tierMultiplier = 0.75;
    detectedTier = "Klein (< 50 €)";
  } else if (bricklinkUsedAvg > 200 || legoSetName.includes("UCS") || legoSetName.includes("Ultimate Collector")) {
    tierMultiplier = 1.25;
    detectedTier = "High-End / UCS (> 200 €)";
  }

  const calculatedPrices = { new: {}, used: {} };

  for (const [key, factor] of Object.entries(BASE_FACTORS.new)) {
    const adjustedFactor = Math.min(factor * tierMultiplier, 0.60);
    calculatedPrices.new[key] = Math.round(bricklinkNewAvg * adjustedFactor);
  }

  for (const [key, factor] of Object.entries(BASE_FACTORS.used)) {
    const adjustedFactor = Math.min(factor * tierMultiplier, 0.50);
    calculatedPrices.used[key] = Math.round(bricklinkUsedAvg * adjustedFactor);
  }

  return {
    statusCode: 200,
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*" 
    },
    body: JSON.stringify({
      set: setNumber,
      name: legoSetName,
      tier: detectedTier, 
      marketPrices: { new: bricklinkNewAvg, used: bricklinkUsedAvg },
      prices: calculatedPrices
    })
  };
};