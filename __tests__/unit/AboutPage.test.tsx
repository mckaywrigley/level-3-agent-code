
import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

describe("AboutPage", () => {
  it("renders AboutPage with the correct text", async () => {
    const content = await AboutPage();
    render(content);
    const aboutText = await screen.findByText("About Page");
    expect(aboutText).toBeInTheDocument();
  });
});
      