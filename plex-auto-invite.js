const puppeteer = require('puppeteer');
//external
const SETTINGS = require('./anilist-downloader-settings.js')

async function inviteUsers(emails) {
    const browser = await puppeteer.launch({
        headless: true,
        slowMo: 50,
        defaultViewport: null
    });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:32400/');

    // LOGIN & NAVIGATE TO INVITE PAGE
    console.log("Login screen")
    const signInButtonSelector = 'button[data-qa-id="signIn--email"]' // cannot wait for not disabled
    await page.waitForSelector(signInButtonSelector)
    await page.waitFor(2000)
    await page.click(signInButtonSelector)

    await page.type('#email', SETTINGS.PLEX.EMAIL)
    await page.type('#password', SETTINGS.PLEX.PASSWORD)
    await page.keyboard.press('Enter')

    console.log("Logging in...")
    const accButSelector = 'button[class^="NavBar-accountButton"]'
    await page.waitForSelector(accButSelector)
    await page.waitFor(2000)

    // PREFERRED SERVER PAGE?
    const preferredServerButtonSelector = 'button[class^="FirstRunExperienceStep-stepButton"]'
    const preferredServerButton = await page.$(preferredServerButtonSelector)
    if (preferredServerButton) {
        console.log("Preferred server screen detected")
        await page.click(preferredServerButtonSelector)
        await page.waitFor(1000)
        console.log("Finding finish button")
        await page.waitForXPath(`//button[contains(., "Finish Setup")]`)
        const [finishButton] = await page.$x(`//button[contains(., "Finish Setup")]`)
        await finishButton.click()
        await page.waitFor(1000)
    }

    await page.click(accButSelector)

    // sketchy
    const userAndSharingSelector = 'button[class^="BadgeMenuItem-badgeMenuItem"]'
    await page.click(userAndSharingSelector)

    // INVITE A USER
    console.log("Sharing & Invite screen")
    const sendInviteEmail = async function(email) {
        console.log(`Inviting ${email}`)
        
        // hyper sketchy
        const shareLibrariesSelector = 'div[class^="SettingsPage-content"] > div[class^="UsersSettingsPageListHeader"] button[class^="UsersSettingsPage"]'
        await page.waitForSelector(shareLibrariesSelector)
        await page.click(shareLibrariesSelector)

        await page.type('#username', email)
        await page.waitForSelector(`button[type="submit"]:not([disabled])`) // wait for Plex
        await page.keyboard.press('Enter')
    
        await page.waitFor(2000)
    
        console.log("Desired library " + SETTINGS.PLEX.LIBRARY_NAME)
        await page.waitForXPath(`//label[contains(., "${SETTINGS.PLEX.LIBRARY_NAME}")]//input`)
        const [checkbox] = await page.$x(`//label[contains(., "${SETTINGS.PLEX.LIBRARY_NAME}")]//input`)
        if (checkbox) {
            await checkbox.click()
        } else {
            console.error("COULD NOT FIND LIBRARY")
            await browser.close();
            return
        }
    
        // sketchy (yes there's a space in front of the class)
        const sendButtonSelector = 'button[class^=" SpinnerButton-button"]'
        await page.click(sendButtonSelector)
    
        await page.waitFor(2000)
    
        const closeWindowSelector = 'button[class^="ModalContent-closeButton"]'
        await page.click(closeWindowSelector)
    }

    for (email of emails) {
        await sendInviteEmail(email)
    }

    await browser.close();
}

/* Standalone 
const emailsToInvite = [ "foo@bar.com", "bar@foo.com" ]
inviteUsers(emailsToInvite);
*/

module.exports.inviteUsers = inviteUsers