const fs = require('fs');
const path = require('path');
function parseNum(str) {
  if (!str) return null;
  str = str.trim();
  if (/[Kk]$/.test(str)) return String(Math.round(parseFloat(str) * 1000));
  if (/[Mm]$/.test(str)) return String(Math.round(parseFloat(str) * 1000000));
  if (/[Bb]$/.test(str)) return String(Math.round(parseFloat(str) * 1000000000));
  return str.replace(/,/g, '');
}

// ─── Shared Puppeteer browser + concurrency limiter ──────────────────────────
// One Chromium instance for the whole bot. At most 2 pages/checks run at once.
let sharedBrowser = null;
let browserStarting = null;
const MAX_CONCURRENT_CHECKS = Math.max(1, Math.min(2, Number(process.env.MAX_CONCURRENT_CHECKS) || 1));
const INSTAGRAM_COOLDOWN_MS = Math.max(60000, Number(process.env.INSTAGRAM_COOLDOWN_MS) || 15 * 60 * 1000);
const CHECK_RETRY_DELAY_MS = Math.max(1000, Number(process.env.CHECK_RETRY_DELAY_MS) || 5000);
let instagramCooldownUntil = 0;
let browserRotationPromise = null;
let browserRotationTimer = null;
let shuttingDown = false;
const managedIntervals = new Set();
let runningChecks = 0;
const checkQueue = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function managedSetInterval(callback, delay) {
  const timer = global.setInterval(callback, delay);
  managedIntervals.add(timer);
  return timer;
}

function getChromePath() {
  let chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  // Running inside pkg exe — find bundled/downloaded Chrome.
  if (!chromePath && typeof process.pkg !== 'undefined') {
    const exeDir = path.dirname(process.execPath);
    const cacheChromeDir = path.join(exeDir, '.cache', 'puppeteer', 'chrome');

    try {
      if (fs.existsSync(cacheChromeDir)) {
        const versions = fs.readdirSync(cacheChromeDir).sort().reverse();
        for (const ver of versions) {
          const candidate = path.join(cacheChromeDir, ver, 'chrome-win64', 'chrome.exe');
          if (fs.existsSync(candidate)) {
            chromePath = candidate;
            console.log(`[browser] Using Chrome: ${chromePath}`);
            break;
          }
        }
      }
    } catch (_) {}

    if (!chromePath) {
      const systemPaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
      ];

      for (const sp of systemPaths) {
        if (fs.existsSync(sp)) {
          chromePath = sp;
          console.log(`[browser] Using system Chrome: ${chromePath}`);
          break;
        }
      }
    }
  }

  return chromePath;
}

async function getBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (browserStarting) return browserStarting;

  browserStarting = (async () => {
    const puppeteer = require('puppeteer');
    const chromePath = getChromePath();

    console.log('[browser] Launching shared Chromium...');

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      // Instagram can keep a renderer/CDP call busy for longer than
      // Puppeteer's default protocol timeout. Give Runtime.callFunctionOn
      // enough time to finish instead of killing healthy checks too early.
      protocolTimeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1280,800'
      ]
    });

    sharedBrowser = browser;

    browser.on('disconnected', () => {
      if (sharedBrowser === browser) sharedBrowser = null;
      console.warn('[browser] Chromium disconnected. It will relaunch on the next check.');
    });

    return browser;
  })();

  try {
    return await browserStarting;
  } finally {
    browserStarting = null;
  }
}

async function acquireCheckSlot() {
  while (!shuttingDown) {
    if (browserRotationPromise) {
      await browserRotationPromise;
      continue;
    }
    if (runningChecks < MAX_CONCURRENT_CHECKS) {
      runningChecks++;
      return true;
    }
    await new Promise(resolve => checkQueue.push(resolve));
  }
  return false;
}

function releaseCheckSlot() {
  runningChecks = Math.max(0, runningChecks - 1);
  const next = checkQueue.shift();
  if (next) next();
}

async function checkOnce(username) {
  let page = null;
  let browser = null;
  let slotAcquired = false;

  try {
    slotAcquired = await acquireCheckSlot();
    if (!slotAcquired || shuttingDown) return null;

    console.log(`[check] ${username} starting (${runningChecks}/${MAX_CONCURRENT_CHECKS} slots used)`);

    browser = await getBrowser();
    page = await browser.newPage();

    // Keep page operations bounded while allowing the CDP protocol itself
    // more time (configured above) for slow Instagram renderer responses.
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    const response = await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    const httpStatus = response?.status?.() ?? 0;
    const landedUrl = page.url();
    if (httpStatus === 429) {
      instagramCooldownUntil = Math.max(instagramCooldownUntil, Date.now() + INSTAGRAM_COOLDOWN_MS);
      console.warn(`[check] Instagram HTTP 429. Global cooldown for ${Math.ceil(INSTAGRAM_COOLDOWN_MS / 60000)} minutes; status UNKNOWN.`);
      return null;
    }
    if (httpStatus >= 500 || (httpStatus >= 400 && httpStatus !== 404 && httpStatus !== 410)) {
      console.warn(`[check] Instagram HTTP ${httpStatus}; status UNKNOWN.`);
      return null;
    }
    if (/\/accounts\/login|challenge|checkpoint/i.test(landedUrl)) {
      console.warn(`[check] ${username}: Instagram redirected to login/challenge (${landedUrl}); status UNKNOWN.`);
      return null;
    }

    // Wait briefly for profile metadata; never infer a ban from missing tags.
    await sleep(2500);

    const data = await page.evaluate(() => {
      const ogDesc = document.querySelector('meta[property="og:description"]');
      const ogImg  = document.querySelector('meta[property="og:image"]');
      return {
        desc: ogDesc?.getAttribute('content') || '',
        img:  ogImg?.getAttribute('content') || ''
      };
    });

    const raw = data.desc || '';
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 5000));
    const unavailablePage = /sorry, this page (isn't|is not) available|the link you followed may be broken|page may have been removed/i.test(bodyText);
    if (httpStatus === 404 || httpStatus === 410 || unavailablePage) {
      console.warn(`[check] ${username}: Instagram returned an explicit unavailable page; treating as unavailable/banned.`);
      return { banned: true, followers: null, following: null, posts: null, profilePic: null, bio: '', isVerified: false, status: 'banned' };
    }
    if (!raw) {
      console.warn(`[check] ${username}: empty profile metadata; status UNKNOWN.`);
      return null;
    }
    console.log(`[check] ${username} og:description:`, raw.substring(0, 100));

    const numPat  = '([\\d,.]+[KMBkmb]?)';
    const fMatch  = raw.match(new RegExp(numPat + '\\s*Followers?', 'i'));
    const foMatch = raw.match(new RegExp(numPat + '\\s*Following', 'i'));
    const pMatch  = raw.match(new RegExp(numPat + '\\s*Posts?', 'i'));

    const followers = fMatch  ? parseNum(fMatch[1])  : null;
    const following = foMatch ? parseNum(foMatch[1]) : null;
    const posts     = pMatch  ? parseNum(pMatch[1])  : null;

    if (followers === null || following === null) {
      console.warn(`[check] ${username}: profile counters missing/unparseable; status UNKNOWN.`);
      return null;
    }
    console.log(`[check] ${username} parsed: followers=${followers}, following=${following}`);

    // Fetch real profile pic using the same page/browser session.
    let profilePic = null;
    if (data.img) {
      try {
        const b64 = await page.evaluate(async (url) => {
          return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = () => {
              if (xhr.status === 200) {
                const bytes = new Uint8Array(xhr.response);
                let binary = '';
                for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
                resolve(btoa(binary));
              } else {
                resolve(null);
              }
            };
            xhr.onerror = () => resolve(null);
            xhr.timeout = 8000;
            xhr.ontimeout = () => resolve(null);
            xhr.send();
          });
        }, data.img);

        if (b64) {
          profilePic = Buffer.from(b64, 'base64');
          console.log(`[check] ${username} profile pic fetched via XHR (${profilePic.length} bytes)`);
        }
      } catch (e) {
        console.log(`[check] ${username} XHR pic failed:`, e.message);
      }
    }

    // Missing metadata is UNKNOWN above, never a ban.
    return { banned: false, followers, following, posts, profilePic, bio: '', isVerified: false, status: 'active' };

  } catch (err) {
    console.error(`[check] Puppeteer error for ${username}:`, err.message);
    return null;
  } finally {
    // Close ONLY the page, never the shared Chromium instance.
    if (page) await page.close().catch(() => {});
    if (slotAcquired) releaseCheckSlot();
  }
}

async function closeSharedBrowser() {
  // Don't kill a browser while checks are still running.
  while (runningChecks > 0) await sleep(100);

  if (sharedBrowser) {
    const browser = sharedBrowser;
    sharedBrowser = null;
    await browser.close().catch(() => {});
    console.log('[browser] Shared Chromium closed.');
  }
}

async function rotateSharedBrowser() {
  if (browserRotationPromise) return browserRotationPromise;
  browserRotationPromise = (async () => {
    console.log('[browser] Scheduled Chromium rotation requested.');
    while (runningChecks > 0) await sleep(250);
    if (sharedBrowser) {
      const oldBrowser = sharedBrowser;
      sharedBrowser = null;
      await oldBrowser.close().catch(err => console.warn('[browser] Rotation close warning:', err.message));
      console.log('[browser] Chromium rotation complete; next check will launch a fresh browser.');
    }
  })();
  try { await browserRotationPromise; }
  finally { browserRotationPromise = null; }
}

// Retry wrapper
const inFlightChecks = new Map();
async function check(username, retries = 2) {
  const normalized = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(normalized)) return null;
  if (Date.now() < instagramCooldownUntil) {
    const remaining = Math.ceil((instagramCooldownUntil - Date.now()) / 1000);
    console.warn(`[check] ${normalized} skipped: Instagram cooldown (${remaining}s remaining); status UNKNOWN.`);
    return null;
  }
  if (inFlightChecks.has(normalized)) return inFlightChecks.get(normalized);
  const task = (async () => {
    for (let i = 0; i < retries; i++) {
      const result = await checkOnce(normalized);
      if (result !== null) return result;
      if (Date.now() < instagramCooldownUntil) return null;
      if (i < retries - 1) await sleep(CHECK_RETRY_DELAY_MS);
    }
    return null;
  })();
  inFlightChecks.set(normalized, task);
  try { return await task; }
  finally { inFlightChecks.delete(normalized); }
}

module.exports = { check, closeSharedBrowser, fmtNum };
