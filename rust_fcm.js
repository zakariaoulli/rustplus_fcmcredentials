const puppeteer = require('puppeteer'); // You'll need to install this first with npm
const AndroidFCM = require('@liamcottle/push-receiver/src/android/fcm');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const PushReceiverClient = require("@liamcottle/push-receiver/src/client");
const commandLineArgs = require('command-line-args');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const protobuf = require("protobufjs");

function updateConfig(configFile, config) {
    // Read current config
    const currentConfig = readConfig(configFile);
    const updatedConfig = { ...currentConfig, ...config };

    // Save updated config
    fs.writeFileSync(configFile, JSON.stringify(updatedConfig, null, 2), "utf8");
}

function getConfigFile(options) {
    return options?.['config-file'] || path.join(process.cwd(), 'rustplus.config.json');
}

function readConfig(configFile) {
    try {
        return JSON.parse(fs.readFileSync(configFile, "utf8"));
    } catch (err) {
        return {};
    }
}

async function getRustPlusToken() {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    await page.goto('https://companion-rust.facepunch.com/login');

    await page.evaluateOnNewDocument(() => {
        window.ReactNativeWebView = {
            postMessage: (message) => {
                try {
                    const auth = JSON.parse(message);
                    console.log('Token:', auth.Token);
                    window.tokenReceived = auth.Token;
                } catch (error) {
                    console.error('Error processing message:', error);
                }
            }
        };
    });

    const token = await page.waitForFunction(() => window.tokenReceived);
    const tokenValue = await token.jsonValue();

    await browser.close();
    return tokenValue;
}

async function getExpoPushToken(fcmToken) {
    try {
        const response = await axios.post('https://exp.host/--/api/v2/push/getExpoPushToken', {
            type: 'fcm',
            deviceId: uuidv4(),
            development: false,
            appId: 'com.facepunch.rust.companion',
            deviceToken: fcmToken,
            projectId: "49451aca-a822-41e6-ad59-955718d0ff9c",
        });

        return response.data.data.expoPushToken;
    } catch (error) {
        console.error("Failed to get Expo Push Token:", error.response?.data || error.message);
        process.exit(1);
    }
}

async function registerWithRustPlus(authToken, expoPushToken) {
    try {
        await axios.post('https://companion-rust.facepunch.com:443/api/push/register', {
            AuthToken: authToken,
            DeviceId: 'rustplus.js',
            PushKind: 3,
            PushToken: expoPushToken,
        });
        console.log("Successfully registered with Rust Companion API.");
    } catch (error) {
        console.error("Failed to register with Rust Companion API:", error.response?.data || error.message);
        process.exit(1);
    }
}

async function registerfcm() {
    console.log("Registering with FCM...");
    const apiKey = "AIzaSyB5y2y-Tzqb4-I4Qnlsh_9naYv_TD8pCvY";
    const projectId = "rust-companion-app";
    const gcmSenderId = "976529667804";
    const gmsAppId = "1:976529667804:android:d6f1ddeb4403b338fea619";
    const androidPackageName = "com.facepunch.rust.companion";
    const androidPackageCert = "E28D05345FB78A7A1A63D70F4A302DBF426CA5AD";

    try {
        const fcmCredentials = await AndroidFCM.register(apiKey, projectId, gcmSenderId, gmsAppId, androidPackageName, androidPackageCert);
        const rustplusAuthToken = await getRustPlusToken();
        const expoPushToken = await getExpoPushToken(fcmCredentials.fcm.token);

        console.log("FCM Token:", rustplusAuthToken);
        console.log("Expo Push Token:", expoPushToken);
        console.log("FCM Credentials:", fcmCredentials);
        await registerWithRustPlus(rustplusAuthToken, expoPushToken).catch((error) => {
            console.log("Failed to register with Rust Companion API");
            console.log(error);
            process.exit(1);
        });
        const configFile = getConfigFile();
        updateConfig(configFile, {
            fcm_credentials: fcmCredentials,
            expo_push_token: expoPushToken,
            rustplus_auth_token: rustplusAuthToken,
        });

        console.log("Registration complete.");
    } catch (error) {
        console.error("Error during FCM registration:", error.message);
        process.exit(1);
    }
}


async function fcmListen(options) {
    // Read config file
    const configFile = getConfigFile(options);
    const config = readConfig(configFile);

    // Ensure FCM credentials exist
    if (!config.fcm_credentials) {
        console.error("FCM Credentials missing. Please run fcm-register first.");
        process.exit(1);
    }

    console.log("Listening for FCM Notifications...");
    const androidId = config.fcm_credentials.gcm.androidId;
    const securityToken = config.fcm_credentials.gcm.securityToken;
    const client = new PushReceiverClient(androidId, securityToken, []);

    client.on('ON_DATA_RECEIVED', (data) => {
        const timestamp = new Date().toLocaleString();
        console.log('\x1b[32m%s\x1b[0m', `[${timestamp}] Notification Received`);
        
        // Extract the 'body' field and parse it as JSON
        const bodyData = data.appData.find(item => item.key === 'body');
        if (bodyData) {
            try {
                const parsedBody = JSON.parse(bodyData.value);
                
                // Create a new object structure with the parsed values
                const processedData = {
                    serverData: {
                        id: parsedBody.id,
                        name: parsedBody.name,
                        description: parsedBody.desc,
                        image: parsedBody.img,
                        logo: parsedBody.logo,
                        url: parsedBody.url,
                        ip: parsedBody.ip,
                        port: parsedBody.port,
                        playerId: parsedBody.playerId,
                        playerToken: parsedBody.playerToken,
                        type: parsedBody.type
                    }
                };
    
                console.log("Processed Data:", processedData);
                updateConfig(configFile, processedData);
                
            } catch (error) {
                console.error("Failed to parse body data:", error);
            }
        } else {
            console.log("No body data found.");
        }
    });
    
    process.on('SIGINT', async () => {
        console.log("Shutting down...");
        process.exit(0);
    });

    try {
        await client.connect();
    } catch (error) {
        console.error("Failed to connect to FCM:", error.message);
        process.exit(1);
    }
}


async function run() {
    const options = commandLineArgs([
        { name: 'command', type: String, defaultOption: true },
        { name: 'config-file', type: String },
    ]);

    switch (options.command) {
        case 'fcm-register':
            await registerfcm();
            break;
        case 'fcm-listen':
            await fcmListen();
            break;
        default:
            console.log("Unknown command.");
    }
}

run();