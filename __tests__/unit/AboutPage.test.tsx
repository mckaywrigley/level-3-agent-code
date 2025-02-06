import AboutPage from "@/app/about/page";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

describe("AboutPage Component", () => {
  it("renders correctly and displays the updated About page text", async () => {
    const content = await AboutPage();
    render(content);
    // Check for updated text
    const headingElement = screen.getByText("This is the About Page");
    expect(headingElement).toBeInTheDocument();
  });
});
