import { log } from './config.mjs';

/** 天气意图检测 */
export function isWeatherIntent(text) {
  return /天气|气温|温度|下雨|降雨|台风|湿度|降温|升温|预报|晴|阴|多云|热不热|冷不冷|穿什么|带伞/.test(text);
}

/** 常见城市列表(优先匹配,最长优先) */
const KNOWN_CITIES = [
  '北京', '上海', '广州', '深圳', '成都', '重庆', '杭州', '武汉', '西安', '南京',
  '苏州', '天津', '长沙', '郑州', '东莞', '青岛', '沈阳', '宁波', '昆明', '大连',
  '厦门', '合肥', '佛山', '福州', '哈尔滨', '济南', '温州', '长春', '石家庄', '泉州',
  '南宁', '贵阳', '南昌', '太原', '烟台', '兰州', '乌鲁木齐', '呼和浩特', '银川', '西宁',
  '拉萨', '海口', '三亚', '珠海', '汕头', '湛江', '惠州', '中山', '无锡', '常州',
  '南通', '徐州', '扬州', '绍兴', '嘉兴', '金华', '台州', '保定', '唐山', '邯郸',
  '洛阳', '南阳', '襄阳', '宜昌', '岳阳', '衡阳', '株洲', '湘潭', '桂林', '柳州',
  '遵义', '绵阳', '德阳', '宜宾', '泸州', '肇庆', '江门', '茂名', '梅州', '清远',
  '韶关', '河源', '阳江', '潮州', '揭阳', '汕尾', '澳门', '香港',
];

/** 从消息中提取城市,找不到用默认城市 */
export function detectCity(text, defaultCity = '广州') {
  // 优先:已知城市列表,最长匹配
  let best = null;
  for (const city of KNOWN_CITIES) {
    if (text.includes(city) && (!best || city.length > best.length)) best = city;
  }
  if (best) return best;
  // 其次:XX市 模式
  const m = text.match(/([\u4e00-\u9fa5]{2,3})市/);
  if (m) return m[1];
  return defaultCity;
}

/** WMO 天气代码 → 中文描述 */
const WMO = {
  0: '晴', 1: '大致晴朗', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '霰',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '小阵雪', 86: '阵雪',
  95: '雷暴', 96: '雷暴伴冰雹', 99: '雷暴伴冰雹',
};
function wmoZh(code) {
  return WMO[code] || `天气代码${code}`;
}

/** 天气缓存:城市 → {time, data} */
const cache = new Map();
const CACHE_TTL = 30 * 60000;

/** 获取实时天气摘要,失败返回 null */
export async function fetchWeather(city) {
  const cached = cache.get(city);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

  // 1) 地理编码
  const geo = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`
  );
  const loc = geo?.results?.[0];
  if (!loc) return null;
  const { latitude: lat, longitude: lon, name, admin1 } = loc;

  // 2) 天气预报
  const f = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&forecast_days=3&timezone=Asia%2FShanghai`
  );
  if (!f?.current) return null;

  const c = f.current;
  const days = (f.daily?.time || []).map((_, i) => ({
    date: f.daily.time[i].slice(5),
    code: f.daily.weather_code[i],
    max: f.daily.temperature_2m_max[i],
    min: f.daily.temperature_2m_min[i],
    pop: f.daily.precipitation_probability_max?.[i],
  }));

  const dayZh = ['今天', '明天', '后天'];
  const lines = [
    `【实时天气:${name}${admin1 ? '(' + admin1 + ')' : ''}】` +
      `当前 ${wmoZh(c.weather_code)},${Math.round(c.temperature_2m)}°C,` +
      `体感${Math.round(c.apparent_temperature)}°C,湿度${Math.round(c.relative_humidity_2m)}%,` +
      `风速${Math.round(c.wind_speed_10m)}km/h${c.precipitation > 0 ? ',降水' + c.precipitation + 'mm' : ''}`,
  ];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    lines.push(
      `${dayZh[i] || d.date}:${wmoZh(d.code)},${Math.round(d.max)}°C~${Math.round(d.min)}°C` +
        (d.pop != null ? `,降水概率${d.pop}%` : '')
    );
  }
  const data = lines.join('\n');
  cache.set(city, { time: Date.now(), data });
  return data;
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'qqai-bot/1.0', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    log(`天气API请求失败: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
