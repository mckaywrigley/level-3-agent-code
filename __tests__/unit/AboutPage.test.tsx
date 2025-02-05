
import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

describe("AboutPage", () => {
  it("renders the AboutPage component and displays 'About Page'", async () => {
    const content = await AboutPage();
    render(content);
    const aboutText = screen.getByText("About Page");
    expect(aboutText).toBeInTheDocument();
  });
});
      