
import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

describe("AboutPage", () => {
  it("renders the about page with correct text", async () => {
    const content = await AboutPage();
    render(content);
    expect(screen.getByText("About Page")).toBeInTheDocument();
  });
});
