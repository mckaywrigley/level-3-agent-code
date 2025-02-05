
import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

describe("AboutPage", () => {
  it("renders the About page correctly", async () => {
    const content = await AboutPage();
    render(content);
    expect(screen.getByText("About Page")).toBeInTheDocument();
  });
});
