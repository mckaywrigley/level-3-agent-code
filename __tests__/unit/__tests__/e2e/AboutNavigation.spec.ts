import { launchApp } from 'test-utils';

// E2E test for About page navigation
describe('About Navigation', () => {
  it('navigates to the About page and displays correct content', async () => {
    const app = await launchApp();
    await app.navigate('/about');
    const aboutText = await app.getText('selector-for-about');
    expect(aboutText).toContain('About Page');
  });
});