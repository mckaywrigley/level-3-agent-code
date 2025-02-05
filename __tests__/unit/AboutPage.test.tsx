
import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

describe("AboutPage", () => {
  it("renders updated AboutPage text", async () => {
    render(await AboutPage());
    expect(screen.getByText("hello world!!!")).toBeInTheDocument();
  });
});
      