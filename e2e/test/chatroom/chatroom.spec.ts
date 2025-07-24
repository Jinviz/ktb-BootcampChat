
// e2e/test/chatroom/chatroom.spec.ts
import { test, expect } from '@playwright/test';
import { TestHelpers } from '../helpers/test-helpers';

test.describe('Chat Room Features', () => {
  const helpers = new TestHelpers();

  test('should allow a user to create a new chat room and send a message', async ({ page }) => {
    const credentials = helpers.getTestUser(Math.floor(Math.random() * 1001));
    await helpers.registerUser(page, credentials);

    const roomNamePrefix = `Test Room ${new Date().getTime()}`;
    const createdRoomName = await helpers.joinOrCreateRoom(page, roomNamePrefix);

    await expect(page.locator('.chat-room-title')).toHaveText(createdRoomName, { timeout: 30000 });

    const message = 'Hello, this is a test message!';
    await page.fill('textarea.chat-input-textarea', message);
    await page.waitForTimeout(500);
    
    // Use a more robust selector for the send button
    await page.locator('button[type="submit"]').click();

    // Add a specific wait for the message to appear in the list
    await page.waitForSelector(`.message-user .message-content:has-text("${message}")`, { timeout: 30000 });

    await expect(page.locator('.message-user .message-content').last()).toContainText(message);
  });

  test('should allow a user to join an existing chat room', async ({ page }) => {
    const user1Credentials = helpers.getTestUser(Math.floor(Math.random() * 1001));
    await helpers.registerUser(page, user1Credentials);
    const roomName = `E2E-Join-Test-${new Date().getTime()}`;
    
    // Directly create the room to have a predictable state
    await helpers.createRoom(page, roomName);

    // Logout
    await page.goto('/chat-rooms');
    await page.waitForLoadState('networkidle');
    const logoutButton = page.locator('button:has-text("로그아웃")');
    if (await logoutButton.isHidden()) {
        const dropdown = page.locator('[data-bs-toggle="dropdown"], [data-toggle="dropdown"]');
        if (await dropdown.isVisible()) {
            await dropdown.click();
        }
    }
    await logoutButton.click();
    await page.waitForURL('/', { timeout: 30000 });

    // Second user joins the room
    const user2Credentials = helpers.getTestUser(Math.floor(Math.random() * 1002));
    await helpers.registerUser(page, user2Credentials);
    
    await page.goto('/chat-rooms');
    await page.waitForLoadState('networkidle');

    // Find the specific room and click to join
    await page.locator(`tr:has-text("${roomName}")`).locator('button:has-text("입장")').click();

    // Verify the user is in the correct room
    await page.waitForURL(`**/chat?room=*`, { timeout: 30000 });
    await expect(page.locator('.chat-room-title')).toHaveText(roomName, { timeout: 30000 });
  });
});
