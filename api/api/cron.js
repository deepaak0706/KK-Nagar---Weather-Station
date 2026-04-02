import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${process.env.APPLICATION_KEY}&api_key=${process.env.API_KEY}&mac=${process.env.MAC}`;

        const response = await fetch(url);
        const ecowitt = await response.json();

        if (ecowitt.code !== 0) {
            return res.status(500).json({ error: ecowitt.msg });
        }

        const d = ecowitt.data;

        // Convert values
        const tempC = ((d.outdoor.temperature.value - 32) * 5 / 9);
        const windKmh = d.wind.wind_speed.value * 1.60934;
        const gustKmh = d.wind.wind_gust.value * 1.60934;
        const rainRate = d.rainfall.rain_rate.value * 25.4;
        const rainTotal = d.rainfall.daily.value * 25.4;

        // Store in Supabase
        const { error } = await supabase.from('weather_logs').insert([{
            temp: tempC,
            humidity: d.outdoor.humidity.value,
            wind: windKmh,
            gust: gustKmh,
            rain: rainRate,
            rain_total: rainTotal
        }]);

        if (error) {
            console.error(error);
            return res.status(500).json({ error });
        }

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
}
