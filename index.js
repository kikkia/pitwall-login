const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createCursor, installMouseHelper } = require('ghost-cursor');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === 'true';

const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('navigator.plugins');
puppeteer.use(stealthPlugin);

function randomDelay(min = 50, max = 200) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanType(page, text, mistakeRate = 0.05) {
    for (const char of text) {
        if (Math.random() < mistakeRate) {
            const wrongChar = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
            await page.keyboard.press(wrongChar, { delay: randomDelay(40, 130) });
            await new Promise(resolve => setTimeout(resolve, randomDelay(80, 220)));
            await page.keyboard.press('Backspace');
            await new Promise(resolve => setTimeout(resolve, randomDelay(60, 150)));
        }

        const requiresShift = (char >= 'A' && char <= 'Z') || '~!@#$%^&*()_+{}|:"<>?'.includes(char);
        if (requiresShift) {
            await page.keyboard.down('Shift');
        }

        try {
            await page.keyboard.press(char, { delay: randomDelay(50, 150) });
        } catch (e) {
            console.error(`Error pressing key: ${char}`, e);
            await page.keyboard.sendCharacter(char);
        }

        if (requiresShift) {
            await page.keyboard.up('Shift');
        }

        await new Promise(resolve => setTimeout(resolve, randomDelay(30, 120)));
    }
}

async function logCookies(page, stage) {
    if (!DEBUG) return;
    const cookies = await page.cookies();
    const sanitized = cookies.map(c =>
        c.name === 'login-session' ? { ...c, value: '[REDACTED]' } : c
    );
    console.log(`--- Cookies at ${stage} ---`);
    console.log(JSON.stringify(sanitized, null, 2));
    console.log(`--- End of Cookies at ${stage} ---`);
}

async function debugScreenshot(page, debugDir, filename) {
    if (!DEBUG) return;
    await page.screenshot({ path: path.join(debugDir, filename) });
}

app.post('/get_token', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const token = await getToken(email, password);
        if (token) {
            res.json({ loginSession: token });
        } else {
            res.status(401).json({ error: 'Invalid credentials or failed to retrieve token' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'An internal server error occurred' });
    }
});

async function getToken(email, password) {
    let browser, page;
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

        const pages = await browser.pages();
        page = pages[0] || await browser.newPage();

        // Enhanced stealth measures
        await page.evaluateOnNewDocument(() => {
            // Remove webdriver property
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });

            // Mock plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    {
                        0: {type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: Plugin},
                        description: "Portable Document Format",
                        filename: "internal-pdf-viewer",
                        length: 1,
                        name: "Chrome PDF Plugin"
                    }
                ],
            });

            // Fix webdriver property
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });

            // Mock Chrome runtime
            window.chrome = {
                runtime: {
                    OnInstalledReason: {
                        CHROME_UPDATE: "chrome_update",
                        INSTALL: "install",
                        SHARED_MODULE_UPDATE: "shared_module_update",
                        UPDATE: "update",
                    },
                    OnRestartRequiredReason: {
                        APP_UPDATE: "app_update",
                        OS_UPDATE: "os_update",
                        PERIODIC: "periodic",
                    },
                    PlatformArch: {
                        ARM: "arm",
                        ARM64: "arm64",
                        MIPS: "mips",
                        MIPS64: "mips64",
                        X86_32: "x86-32",
                        X86_64: "x86-64",
                    },
                    PlatformNaclArch: {
                        ARM: "arm",
                        MIPS: "mips",
                        MIPS64: "mips64",
                        X86_32: "x86-32",
                        X86_64: "x86-64",
                    },
                    PlatformOs: {
                        ANDROID: "android",
                        CROS: "cros",
                        LINUX: "linux",
                        MAC: "mac",
                        OPENBSD: "openbsd",
                        WIN: "win",
                    },
                    RequestUpdateCheckStatus: {
                        NO_UPDATE: "no_update",
                        THROTTLED: "throttled",
                        UPDATE_AVAILABLE: "update_available",
                    },
                },
                loadTimes: function() {},
                csi: function() {},
                app: {}
            };

            // Override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );

            // Add realistic language properties
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });

            Object.defineProperty(navigator, 'language', {
                get: () => 'en-US',
            });

            // Mock battery API (often checked)
            if (!navigator.getBattery) {
                navigator.getBattery = () => Promise.resolve({
                    charging: true,
                    chargingTime: 0,
                    dischargingTime: Infinity,
                    level: 1,
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    onchargingchange: null,
                    onchargingtimechange: null,
                    ondischargingtimechange: null,
                    onlevelchange: null
                });
            }

            // Mock connection API
            Object.defineProperty(navigator, 'connection', {
                get: () => ({
                    effectiveType: '4g',
                    downlink: 10,
                    rtt: 50,
                    saveData: false,
                }),
            });

            // Mock deviceMemory
            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8,
            });

            // Mock hardwareConcurrency
            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => 8,
            });

            // Mock platform
            Object.defineProperty(navigator, 'platform', {
                get: () => 'Win32',
            });

            // Mock vendor
            Object.defineProperty(navigator, 'vendor', {
                get: () => 'Google Inc.',
            });

            // Add realistic screen properties
            Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
            Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
            Object.defineProperty(screen, 'width', { get: () => 1920 });
            Object.defineProperty(screen, 'height', { get: () => 1080 });
            Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
            Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

            // Mock WebGL vendor and renderer
            const getParameter = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) {
                    return 'Intel Inc.';
                }
                if (parameter === 37446) {
                    return 'Intel Iris OpenGL Engine';
                }
                return getParameter.apply(this, [parameter]);
            };

            // Mock canvas fingerprinting
            const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function(type) {
                const context = this.getContext('2d');
                if (context) {
                    const imageData = context.getImageData(0, 0, this.width, this.height);
                    for (let i = 0; i < imageData.data.length; i += 4) {
                        imageData.data[i] += Math.floor(Math.random() * 3) - 1;
                        imageData.data[i + 1] += Math.floor(Math.random() * 3) - 1;
                        imageData.data[i + 2] += Math.floor(Math.random() * 3) - 1;
                    }
                    context.putImageData(imageData, 0, 0);
                }
                return originalToDataURL.apply(this, [type]);
            };

            // Hide automation detection
            delete Object.getPrototypeOf(navigator).webdriver;

            // Mock media devices
            if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
                const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices;
                navigator.mediaDevices.enumerateDevices = function() {
                    return originalEnumerateDevices.call(this).then(devices => {
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
        
        // Use a more realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        
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
            waitUntil: 'networkidle0',
            timeout: 30000
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
        await page.waitForSelector(signInButtonSelector, { timeout: 10000 });
        
        await cursor.click(signInButtonSelector, {
            hesitate: randomDelay(1500, 2500),
            waitForClick: randomDelay(100, 250),
            moveDelay: randomDelay(200, 400),
            randomizeMoveDelay: true,
        });
        
        await cursor.moveTo({ x: Math.random() * viewport.width, y: Math.random() * viewport.height });
        await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1000)));
        
        await page.waitForSelector('.txtLogin', { timeout: 10000 });
        console.log('Login page loaded.');
        await logCookies(page, 'after page load');

        await debugScreenshot(page, debugDir, '01-login-page.png');
        console.log('Waiting for page to settle...');
        await new Promise(resolve => setTimeout(resolve, randomDelay(2000, 3500)));

        // More human-like interaction with the form
        console.log('Interacting with email field...');
        const emailSelector = '.txtLogin';
        
        // Move mouse near the field first
        const emailElement = await page.$(emailSelector);
        const emailBox = await emailElement.boundingBox();
        await cursor.moveTo({ 
            x: emailBox.x + emailBox.width / 2 + randomDelay(-20, 20), 
            y: emailBox.y + emailBox.height / 2 + randomDelay(-10, 10)
        });
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
        const passwordSelector = '.txtPassword';
        await page.waitForSelector(passwordSelector);
        
        const passwordElement = await page.$(passwordSelector);
        const passwordBox = await passwordElement.boundingBox();
        await cursor.moveTo({ 
            x: passwordBox.x + passwordBox.width / 2 + randomDelay(-20, 20), 
            y: passwordBox.y + passwordBox.height / 2 + randomDelay(-10, 10)
        });
        await new Promise(resolve => setTimeout(resolve, randomDelay(300, 800)));
        
        await cursor.click(passwordSelector, {
            hesitate: randomDelay(200, 600),
            waitForClick: randomDelay(100, 200),
            moveDelay: randomDelay(100, 300),
            randomizeMoveDelay: true,
        });
        await new Promise(resolve => setTimeout(resolve, randomDelay(300, 600)));
        
        console.log('Typing password...');
        await humanType(page, password, 0.03);
        console.log('Password typed.');
        await debugScreenshot(page, debugDir, '02-credentials-entered.png');

        await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1000)));

        console.log('Clicking login button...');
        const loginButtonSelector = '#loginform > div:nth-child(4) > button:nth-child(2)';
        await page.waitForSelector(loginButtonSelector);
        
        const loginButton = await page.$(loginButtonSelector);
        const loginBox = await loginButton.boundingBox();
        await cursor.moveTo({ 
            x: loginBox.x + loginBox.width / 2 + randomDelay(-10, 10), 
            y: loginBox.y + loginBox.height / 2 + randomDelay(-5, 5)
        });
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
        await new Promise(resolve => {
            const checkCookie = setInterval(async () => {
                const cookies = await page.cookies();
                loginSessionCookie = cookies.find(c => c.name === 'login-session');
                if (loginSessionCookie) {
                    console.log('Login session cookie found.');
                    clearInterval(checkCookie);
                    resolve();
                }
            }, 1000);

            setTimeout(() => {
                clearInterval(checkCookie);
                resolve(); // End the wait after 30 seconds regardless
            }, 30000);
        });

        if (loginSessionCookie) {
            const cookieValue = JSON.parse(decodeURIComponent(loginSessionCookie.value));
            return {
                expires: loginSessionCookie.expires,
                subscriptionToken: cookieValue.data.subscriptionToken
            };
        } else {
            console.log('Login session cookie not found.');
            await debugScreenshot(page, debugDir, '04-token-not-found.png');
            return null;
        }
    } catch (error) {
        console.error('Error in getToken:', error);
        if (page) {
            await debugScreenshot(page, debugDir, 'error-screenshot.png');
        }
        throw error;
    } finally {
        if (page) {
            await logCookies(page, 'before browser close');
        }
        if (browser) {
            console.log('Closing browser.');
            await browser.close();
            console.log('Browser closed.');
        }
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});