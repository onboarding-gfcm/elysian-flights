// ===== DYNAMIC PRICING CONFIG =====
// Price per point in EUR for each loyalty program
const POINT_PRICES = {
  qantas: 0.017,
  flying_blue: 0.027,
  virginatlantic: 0.018,
  american: 0.026
};
const MARGIN = 150; // EUR profit margin per ticket

// Approximate exchange rates to EUR
const EUR_RATES = { EUR:1, USD:0.92, GBP:1.16, AUD:0.60, CAD:0.68, QAR:0.25, AED:0.25 };

function toEur(amountCents, currency) {
  if (!amountCents || amountCents <= 0) return 0;
  const amount = amountCents / 100; // API returns cents
  const rate = EUR_RATES[(currency || 'USD').toUpperCase()] || 0.92;
  return amount * rate;
}

function calcPrice(miles, taxes, taxCur, progKey) {
  if (!miles || miles <= 0) return null;
  const pp = POINT_PRICES[progKey] || 0.02;
  return Math.round(miles * pp + toEur(taxes, taxCur) + MARGIN);
}

// Program configurations
const PROGRAMS = {
  qantas:        { source: 'qantas',        carriers: 'EK',       label: 'Qantas',           maxStops: 0,    maxPoints: null,   allowPremiumEconomy: false },
  flying_blue:   { source: 'flying_blue',   carriers: 'EY,KL,AF', label: 'Flying Blue',       maxStops: 1,    maxPoints: 90000,  allowPremiumEconomy: true  },
  virginatlantic:{ source: 'virginatlantic', carriers: '',          label: 'Virgin Atlantic',   maxStops: 1,    maxPoints: 160000, allowPremiumEconomy: true  },
  american:      { source: 'american',       carriers: 'EY',       label: 'American Airlines',  maxStops: null, maxPoints: 60000,  allowPremiumEconomy: false }
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { origin, destination, date } = req.query;
  if (!origin || !destination) {
    return res.status(400).json({ error: 'origin and destination required' });
  }

  // Multiple API keys for automatic failover on rate limits (429)
  const API_KEYS = [
    process.env.SEATS_AERO_API_KEY || 'pro_2xaxtKyA0PHA0FMViRkybESjNR6',
    process.env.SEATS_AERO_API_KEY_2 || 'pro_3BJEOeNGuFgOqILdybD3Uq8Ph6E'
  ].filter(k => k.length > 0);

  let activeKeyIndex = 0;

  async function fetchWithFailover(url, keyIndex) {
    const apiKey = API_KEYS[keyIndex];
    const resp = await fetch(url, {
      headers: { 'Partner-Authorization': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (resp.status === 429 && keyIndex + 1 < API_KEYS.length) {
      console.log(`[Key ${keyIndex + 1}] Rate limited (429), switching to key ${keyIndex + 2}`);
      activeKeyIndex = keyIndex + 1;
      return fetchWithFailover(url, keyIndex + 1);
    }
    return resp;
  }

  try {
    const programKeys = Object.keys(PROGRAMS);
    const apiCalls = programKeys.map(key => {
      const cfg = PROGRAMS[key];
      const params = new URLSearchParams({
        origin_airport: origin,
        destination_airport: destination,
        sources: cfg.source,
        include_trips: 'true',
        take: '50'
      });

      // Only add carriers filter if specified
      if (cfg.carriers) {
        params.set('carriers', cfg.carriers);
      }

      if (date) {
        params.set('start_date', date);
        params.set('end_date', date);
      }

      const apiUrl = `https://seats.aero/partnerapi/search?${params.toString()}`;
      console.log(`[${cfg.label}] Calling: ${apiUrl} (key ${activeKeyIndex + 1})`);

      return fetchWithFailover(apiUrl, activeKeyIndex)
      .then(async resp => {
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.log(`[${cfg.label}] API returned ${resp.status}: ${errText.substring(0, 200)}`);
          return { key, cfg, data: [], error: `${resp.status}` };
        }
        const raw = await resp.json();
        const data = raw.data || [];
        console.log(`[${cfg.label}] returned ${Array.isArray(data) ? data.length : 0} results`);
        return { key, cfg, data: Array.isArray(data) ? data : [] };
      })
      .catch(err => {
        console.log(`[${cfg.label}] error: ${err.message}`);
        return { key, cfg, data: [], error: err.message };
      });
    });

    const results = await Promise.all(apiCalls);
    const allFlights = [];

    for (const { key, cfg, data } of results) {
      for (const avail of data) {
        const hasJ = avail.JAvailable === true;
        const hasF = avail.FAvailable === true;
        const hasW = cfg.allowPremiumEconomy && avail.WAvailable === true;
        if (!hasJ && !hasF && !hasW) continue;

        // Extract taxes from seats.aero response
        const taxCur = avail.TaxesCurrency || 'USD';
        const jTax = avail.JTotalTaxes || 0;
        const fTax = avail.FTotalTaxes || 0;
        const wTax = avail.WTotalTaxes || 0;

        const trips = avail.AvailabilityTrips || [];

        if (trips.length === 0) {
          const isDirect = (hasJ && avail.JDirect === true) || (hasF && avail.FDirect === true) || (hasW && avail.WDirect === true);
          if (cfg.maxStops === 0 && !isDirect) continue;

          const mileageCost = avail.JMileageCost || avail.FMileageCost || avail.WMileageCost || 0;
          if (cfg.maxPoints && mileageCost > cfg.maxPoints) continue;

          const jAirlines = avail.JAirlines || '';
          const fAirlines = avail.FAirlines || '';
          const wAirlines = avail.WAirlines || '';
          const primaryAirline = (jAirlines || fAirlines || wAirlines || '').split(',')[0].trim() || '';

          allFlights.push({
            id: avail.ID,
            date: avail.Date || date,
            origin: avail.Route?.OriginAirport || origin,
            destination: avail.Route?.DestinationAirport || destination,
            depTime: '',
            arrTime: '',
            duration: '',
            flightNo: primaryAirline + '---',
            airline: primaryAirline,
            program: cfg.label,
            programKey: key,
            source: avail.Source || cfg.source,
            segments: [],
            stops: isDirect ? 0 : null,
            availability: { premiumEconomy: hasW, business: hasJ, first: hasF },
            prices: {
              premiumEconomy: hasW ? calcPrice(avail.WMileageCost, wTax, taxCur, key) : null,
              business: hasJ ? calcPrice(avail.JMileageCost, jTax, taxCur, key) : null,
              first: hasF ? calcPrice(avail.FMileageCost, fTax, taxCur, key) : null
            },
            direct: isDirect,
            remainingSeats: Math.max(avail.JRemainingSeats || 0, avail.FRemainingSeats || 0) || 1,
            _mileage: { business: avail.JMileageCost || null, first: avail.FMileageCost || null },
            _taxes: { business: jTax, first: fTax, currency: taxCur }
          });
          continue;
        }

        // Process individual trips
        for (const trip of trips) {
          const cabin = (trip.Cabin || '').toLowerCase();
          if (cabin === 'economy' || cabin === 'y') continue;
          const isPremEcon = cabin === 'premium_economy' || cabin === 'premium' || cabin === 'w';
          if (isPremEcon && !cfg.allowPremiumEconomy) continue;

          const stops = trip.Stops || 0;
          const isDirect = stops === 0;
          if (cfg.maxStops !== null && cfg.maxStops !== undefined && stops > cfg.maxStops) continue;

          const mileageCost = trip.MileageCost || avail.JMileageCost || avail.FMileageCost || avail.WMileageCost || 0;
          if (cfg.maxPoints && mileageCost > cfg.maxPoints) continue;

          const tripTax = trip.TotalTaxes || (cabin === 'first' || cabin === 'f' ? fTax : (isPremEcon ? wTax : jTax));
          const depTime = formatDateTime(trip.DepartsAt);
          const arrTime = formatDateTime(trip.ArrivesAt);
          const duration = trip.TotalDuration || computeDuration(trip.DepartsAt, trip.ArrivesAt);
          const flightNo = trip.FlightNumbers || '---';
          const carriers = trip.Carriers || '';
          const airlineCode = carriers.split(',')[0].trim() || '';

          // Build connection segments
          const connRaw = trip.Connections || '';
          const connections = (typeof connRaw === 'string' && connRaw)
            ? connRaw.split(',').map(c => c.trim())
            : [];

          const segmentDetails = [];
          if (connections.length > 0 && !isDirect) {
            const allPoints = [trip.OriginAirport, ...connections, trip.DestinationAirport];
            const flightNos = flightNo.split(',').map(f => f.trim());
            for (let i = 0; i < allPoints.length - 1; i++) {
              segmentDetails.push({
                flightNo: flightNos[i] || flightNo,
                origin: allPoints[i] || '',
                destination: allPoints[i + 1] || '',
                depTime: i === 0 ? depTime : '',
                arrTime: i === allPoints.length - 2 ? arrTime : '',
                duration: '',
                aircraft: '',
                fareClass: trip.Cabin || ''
              });
            }
          } else {
            segmentDetails.push({
              flightNo,
              origin: trip.OriginAirport || origin,
              destination: trip.DestinationAirport || destination,
              depTime,
              arrTime,
              duration,
              aircraft: '',
              fareClass: trip.Cabin || ''
            });
          }

          const isFirst = cabin === 'first' || cabin === 'f';
          const price = calcPrice(mileageCost, tripTax, taxCur, key);

          allFlights.push({
            id: trip.ID || avail.ID + '-' + (trip.Order || 0),
            date: avail.Date || date,
            origin: trip.OriginAirport || origin,
            destination: trip.DestinationAirport || destination,
            depTime,
            arrTime,
            duration,
            flightNo,
            airline: airlineCode,
            connections: connections,
            program: cfg.label,
            programKey: key,
            source: avail.Source || cfg.source,
            segments: segmentDetails,
            stops,
            availability: {
              premiumEconomy: isPremEcon,
              business: !isFirst && !isPremEcon,
              first: isFirst
            },
            prices: {
              premiumEconomy: isPremEcon ? price : null,
              business: (!isFirst && !isPremEcon) ? price : null,
              first: isFirst ? price : null
            },
            direct: isDirect,
            remainingSeats: trip.RemainingSeats || Math.max(avail.JRemainingSeats || 0, avail.FRemainingSeats || 0) || 1,
            _mileage: { business: mileageCost || null, first: avail.FMileageCost || null },
            _taxes: { business: jTax, first: fTax, currency: taxCur, tripTax }
          });
        }
      }
    }

    // Deduplicate
    const seen = new Set();
    const uniqueFlights = allFlights.filter(f => {
      const k = `${f.programKey}|${f.flightNo}|${f.depTime}|${f.date}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const programOrder = { qantas: 0, flying_blue: 1, virginatlantic: 2, american: 3 };
    uniqueFlights.sort((a, b) => {
      const pa = programOrder[a.programKey] ?? 99;
      const pb = programOrder[b.programKey] ?? 99;
      if (pa !== pb) return pa - pb;
      if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
      return (a.depTime || '').localeCompare(b.depTime || '');
    });

    const perProgram = {};
    for (const f of uniqueFlights) {
      perProgram[f.program] = (perProgram[f.program] || 0) + 1;
    }

    return res.json({
      flights: uniqueFlights.slice(0, 100),
      source: 'api',
      programs: Object.keys(PROGRAMS).map(k => PROGRAMS[k].label),
      perProgram,
      totalDisplayed: uniqueFlights.length
    });

  } catch (e) {
    console.error('seats.aero API error:', e.message);
    return res.json({ flights: [], source: 'error', error: e.message });
  }
};

function formatDateTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toISOString().substring(11, 16);
  } catch { return ''; }
}

function computeDuration(depStr, arrStr) {
  if (!depStr || !arrStr) return '';
  try {
    const dep = new Date(depStr);
    const arr = new Date(arrStr);
    const diffMs = arr - dep;
    if (diffMs < 0) return '';
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    return `${hours}h ${mins.toString().padStart(2, '0')}m`;
  } catch { return ''; }
}
