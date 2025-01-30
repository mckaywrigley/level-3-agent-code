import { render, screen } from "@testing-library/react";
import AboutPage from "@/app/about/page";

describe("AboutPage", () => {
  it("renders About Page text", () => {
    render(<AboutPage />);
    expect(screen.getByText("About Page")).toBeInTheDocument();
  });
});