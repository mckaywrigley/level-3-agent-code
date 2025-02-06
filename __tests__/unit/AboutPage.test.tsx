
/* Unit test for AboutPage component with added comments */
// This test verifies that the AboutPage component renders correctly and displays the expected title.
import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

describe("AboutPage", () => {
  it("renders the AboutPage component and displays 'About Page'", async () => {
    // Retrieve the page content (assuming AboutPage is an async function or component)
    const content = await AboutPage();
    render(content);
    // Assert that the text "About Page" appears in the document.
    const aboutText = screen.getByText("About Page");
    expect(aboutText).toBeInTheDocument();
  });
});
