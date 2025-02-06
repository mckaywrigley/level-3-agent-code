
import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

// Unit tests for AboutPage component.
describe("AboutPage Component", () => {
  // Verify that the component renders and displays "About Page".
  it("renders correctly and displays 'About Page'", async () => {
    const content = await AboutPage();
    render(content);
    const aboutText = screen.getByText("About Page");
    expect(aboutText).toBeInTheDocument();
  });

  // Additional test: Check for the presence of a header element.
  it("contains a header element", async () => {
    const content = await AboutPage();
    render(content);
    // Assuming the header role is defined (e.g. a banner).
    const header = screen.getByRole("banner");
    expect(header).toBeInTheDocument();
  });
});
