const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createCursor, installMouseHelper } = require('ghost-cursor');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === 'true';
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS) || 80000;
const API_KEY = process.env.API_KEY || '';
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE) || 3;

let loginInFlight = false;
const loginQueue = [];
let activeBrowser = null;
let isShuttingDown = false;

const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
puppeteer.use(stealthPlugin);

function randomDelay(min = 50, max = 200) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanType(page, text, mistakeRate = 0.05) {
    for (const char of text) {
        if (mistakeRate > 0 && Math.random() < mistakeRate) {
            const wrongChar = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
            await page.keyboard.type(wrongChar, { delay: randomDelay(40, 130) });
            await new Promise(resolve => setTimeout(resolve, randomDelay(80, 220)));
            await page.keyboard.press('Backspace');
            await new Promise(resolve => setTimeout(resolve, randomDelay(60, 150)));
        }

        try {
            await page.keyboard.type(char, { delay: randomDelay(50, 150) });
        } catch (e) {
            console.error('Error typing character:', e.message);
            await page.keyboard.sendCharacter(char);
        }

        await new Promise(resolve => setTimeout(resolve, randomDelay(30, 120)));
    }
}

async function moveNearElement(page, cursor, selector, jitterX = 20, jitterY = 10) {
    const element = await page.$(selector);
    if (!element) return;
    const box = await element.boundingBox();
    if (!box) return;
    await cursor.moveTo({
        x: box.x + box.width / 2 + randomDelay(-jitterX, jitterX),
        y: box.y + box.height / 2 + randomDelay(-jitterY, jitterY)
    });
}

async function logCookies(page, stage) {
    if (!DEBUG) return;
    const cookies = await page.cookies();
    const sanitized = cookies.map(c =>
        /session|token|auth/i.test(c.name) ? { ...c, value: '[REDACTED]' } : c
    );
    console.log(`--- Cookies at ${stage} ---`);
    console.log(JSON.stringify(sanitized, null, 2));
    console.log(`--- End of Cookies at ${stage} ---`);
}

async function debugScreenshot(page, debugDir, filename) {
    if (!DEBUG) return;
    await page.screenshot({ path: path.join(debugDir, filename) });
}

function requireApiKey(req, res, next) {
    if (!API_KEY) return next();

    const headerKey = req.get('x-api-key');
    const authHeader = req.get('authorization') || '';
    const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const provided = headerKey || bearerKey;

    if (!provided) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const expectedBuf = Buffer.from(API_KEY);
    const providedBuf = Buffer.from(provided);
    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

function runSerialized(task) {
    return new Promise((resolve, reject) => {
        if (loginInFlight && loginQueue.length >= MAX_QUEUE_SIZE) {
            const err = new Error('Too many concurrent login requests');
            err.statusCode = 429;
            return reject(err);
        }

        const execute = async () => {
            loginInFlight = true;
            try {
                resolve(await task());
            } catch (err) {
                reject(err);
            } finally {
                loginInFlight = false;
                const next = loginQueue.shift();
                if (next) next();
            }
        };

        if (loginInFlight) {
            loginQueue.push(execute);
        } else {
            execute();
        }
    });
}

app.get('/health', (req, res) => {
    if (isShuttingDown) {
        return res.status(503).json({ status: 'shutting_down' });
    }
    res.json({ status: 'ok', busy: loginInFlight });
});

app.post('/get_token', requireApiKey, async (req, res) => {
    if (isShuttingDown) {
        return res.status(503).json({ error: 'Server is shutting down' });
    }

    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const token = await runSerialized(() => getToken(email, password));
        if (token) {
            res.json({ loginSession: token });
        } else {
            res.status(401).json({ error: 'Invalid credentials or failed to retrieve token' });
        }
    } catch (error) {
        console.error(error);
        const status = error.statusCode || 500;
        const message = status === 429 ? error.message : 'An internal server error occurred';
        res.status(status).json({ error: message });
    }
});

async function getToken(email, password) {
    let browser, page;
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    const remainingMs = (max) => {
        const left = deadline - Date.now();
        if (left <= 0) {
            throw new Error(`Login timed out after ${LOGIN_TIMEOUT_MS}ms`);
        }
        return Math.min(max, left);
    };
    const debugDir = './debug';
    if (DEBUG && !fs.existsSync(debugDir)){
        fs.mkdirSync(debugDir, { recursive: true });
    }

    try {
        console.log('Launching browser...');
        const extensionPath = path.join(__dirname, 'extension', 'isdcac');

        browser = await puppeteer.launch({
            headless: false,
            enableExtensions: true,
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--hide-scrollbars',
                '--mute-audio',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI,BlinkGenPropertyTrees',
                '--disable-ipc-flooding-protection',
                '--window-size=1920,1080',
                '--window-position=0,0'
            ],
            ignoreDefaultArgs: ['--enable-automation'],
            defaultViewport: null
        });
        activeBrowser = browser;

        const pages = await browser.pages();
        page = pages[0] || await browser.newPage();

        // Consistent browser fingerprint helpers (leaving OS/UA/WebGL consistent with host Chromium)
        await page.evaluateOnNewDocument(() => {
            if (window.navigator.permissions && window.navigator.permissions.query) {
                const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : originalQuery(parameters)
                );
            }

            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });

            Object.defineProperty(navigator, 'language', {
                get: () => 'en-US',
            });

            if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
                const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
                navigator.mediaDevices.enumerateDevices = function() {
                    return originalEnumerateDevices().then(devices => {
                        if (devices.length === 0) {
                            return [
                                { deviceId: 'default', kind: 'audioinput', label: '', groupId: 'group1' },
                                { deviceId: 'default', kind: 'audiooutput', label: '', groupId: 'group1' },
                                { deviceId: 'default', kind: 'videoinput', label: '', groupId: 'group2' }
                            ];
                        }
                        return devices;
                    });
                };
            }
        });

        if (DEBUG) {
            await installMouseHelper(page);
        }
        
        await page.setViewport({ width: 1920, height: 1080 });
        const viewport = await page.viewport();
        
        const cursor = createCursor(
            page,
            { x: Math.random() > 0.5 ? 0 : viewport.width, y: Math.random() * viewport.height },
            true,
            {
                move: {
                    moveSpeed: randomDelay(300, 450)
                }
            }
        );
        
        console.log('Browser launched. Page created.');
        // The browser extension will handle cookies, so we don't need to set them manually.

        console.log('Navigating to F1 TV homepage...');
        await page.goto('https://f1tv.formula1.com/', {
            waitUntil: 'domcontentloaded',
            timeout: remainingMs(20000)
        });
        console.log('F1 TV homepage loaded.');
        
        // Random mouse movements to simulate browsing
        await cursor.moveTo({ x: Math.random() * viewport.width, y: Math.random() * viewport.height });
        await new Promise(resolve => setTimeout(resolve, randomDelay(1000, 2000)));

        // Scroll a bit to simulate reading
        await page.evaluate(() => {
            window.scrollBy(0, Math.random() * 300);
        });
        await new Promise(resolve => setTimeout(resolve, randomDelay(800, 1500)));

        const signInButtonSelector = 'a.btn.btn-f1-dark[title="Sign in"]';
        await page.waitForSelector(signInButtonSelector, { timeout: remainingMs(15000) });
        
        await cursor.click(signInButtonSelector, {
            hesitate: randomDelay(1500, 2500),
            waitForClick: randomDelay(100, 250),
            moveDelay: randomDelay(200, 400),
            randomizeMoveDelay: true,
        });
        
        await cursor.moveTo({ x: Math.random() * viewport.width, y: Math.random() * viewport.height });
        await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1000)));
        
        const emailSelector = '#username, .txtLogin';
        await page.waitForSelector(emailSelector, { timeout: remainingMs(15000) });
        console.log('Login page loaded.');
        await logCookies(page, 'after page load');

        await debugScreenshot(page, debugDir, '01-login-page.png');
        console.log('Waiting for page to settle...');
        await new Promise(resolve => setTimeout(resolve, randomDelay(2000, 3500)));

        // More human-like interaction with the form
        console.log('Interacting with email field...');
        
        // Move mouse near the field first
        await moveNearElement(page, cursor, emailSelector, 20, 10);
        await new Promise(resolve => setTimeout(resolve, randomDelay(300, 800)));
        
        await cursor.click(emailSelector, {
            hesitate: randomDelay(200, 600),
            waitForClick: randomDelay(100, 200),
            moveDelay: randomDelay(100, 300),
            randomizeMoveDelay: true,
        });
        await new Promise(resolve => setTimeout(resolve, randomDelay(300, 600)));
        
        console.log('Typing email...');
        await humanType(page, email, 0.03);
        console.log('Email typed.');

        await new Promise(resolve => setTimeout(resolve, randomDelay(800, 1500)));
        
        console.log('Interacting with password field...');
        const passwordSelector = '#password, .txtPassword';
        await page.waitForSelector(passwordSelector, { timeout: remainingMs(10000) });
        
        await moveNearElement(page, cursor, passwordSelector, 20, 10);
        await new Promise(resolve => setTimeout(resolve, randomDelay(300, 800)));
        
        await cursor.click(passwordSelector, {
            hesitate: randomDelay(200, 600),
            waitForClick: randomDelay(100, 200),
            moveDelay: randomDelay(100, 300),
            randomizeMoveDelay: true,
        });
        await new Promise(resolve => setTimeout(resolve, randomDelay(300, 600)));
        
        console.log('Typing password...');
        await humanType(page, password, 0);
        console.log('Password typed.');
        await debugScreenshot(page, debugDir, '02-credentials-entered.png');

        await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1000)));

        console.log('Clicking login button...');
        const loginButtonSelector = '#btnLogin, #loginform button[type="submit"], #loginform > div:nth-child(4) > button:nth-child(2)';
        await page.waitForSelector(loginButtonSelector, { timeout: remainingMs(10000) });
        
        await moveNearElement(page, cursor, loginButtonSelector, 10, 5);
        await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1000)));
        
        await cursor.click(loginButtonSelector, {
            hesitate: randomDelay(300, 800),
            waitForClick: randomDelay(150, 300),
            moveDelay: randomDelay(100, 250),
            randomizeMoveDelay: true,
        });
        console.log('Login button clicked.');
        await logCookies(page, 'after login click');
        
        await new Promise(resolve => setTimeout(resolve, 7000));
        await debugScreenshot(page, debugDir, '03-after-login-click.png');

        console.log('Waiting for login session cookie...');
        let loginSessionCookie = null;
        const pollDeadline = Math.min(Date.now() + 30000, deadline);
        while (Date.now() < pollDeadline) {
            try {
                const cookies = await page.cookies();
                loginSessionCookie = cookies.find(c => c.name === 'login-session');
                if (loginSessionCookie) {
                    console.log('Login session cookie found.');
                    break;
                }
            } catch (pollErr) {
                console.warn('Error polling cookies:', pollErr.message);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (loginSessionCookie) {
            try {
                const cookieValue = JSON.parse(decodeURIComponent(loginSessionCookie.value));
                const subscriptionToken = cookieValue && cookieValue.data && cookieValue.data.subscriptionToken;
                if (!subscriptionToken) {
                    console.error('Login session cookie missing subscriptionToken.');
                    return null;
                }
                return {
                    expires: loginSessionCookie.expires,
                    subscriptionToken
                };
            } catch (parseErr) {
                console.error('Failed to parse login-session cookie:', parseErr);
                return null;
            }
        } else {
            console.log('Login session cookie not found.');
            await debugScreenshot(page, debugDir, '04-token-not-found.png');
            return null;
        }
    } catch (error) {
        console.error('Error in getToken:', error);
        if (page) {
            try {
                await debugScreenshot(page, debugDir, 'error-screenshot.png');
            } catch (screenshotErr) {
                console.warn('Failed to capture error screenshot:', screenshotErr.message);
            }
        }
        throw error;
    } finally {
        if (page) {
            try {
                await logCookies(page, 'before browser close');
            } catch (cookieErr) {
                console.warn('Failed to log cookies before close:', cookieErr.message);
            }
        }
        if (browser) {
            if (activeBrowser === browser) {
                activeBrowser = null;
            }
            console.log('Closing browser.');
            try {
                await browser.close();
                console.log('Browser closed.');
            } catch (closeErr) {
                console.error('Failed to close browser cleanly:', closeErr);
            }
        }
    }
}

const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);

    server.close(async () => {
        if (activeBrowser) {
            try {
                await activeBrowser.close();
            } catch (err) {
                console.error('Error closing browser during shutdown:', err);
            }
            activeBrowser = null;
        }
        process.exit(0);
    });

    setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));