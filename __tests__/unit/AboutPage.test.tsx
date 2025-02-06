import AboutPage from '@/app/about/page'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/extend-expect';

describe('AboutPage Component', () => {
  it('renders the About Page with updated text', async () => {
    const content = await AboutPage();
    render(content);
    const aboutElement = screen.getByText('About Page');
    expect(aboutElement).toBeInTheDocument();
  });
});