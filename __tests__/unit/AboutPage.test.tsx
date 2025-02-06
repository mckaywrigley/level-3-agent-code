import AboutPage from '@/app/about/page';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

describe('AboutPage Component', () => {
  it('renders correctly and displays the updated About page text', async () => {
    const content = await AboutPage();
    render(content);
    // Updated text check
    const headingElement = screen.getByText('About Page');
    expect(headingElement).toBeInTheDocument();
  });
});
