
import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

describe("AboutPage", () => {
  it("renders AboutPage with the correct text", async () => {
    // Call the server component function (it returns JSX)
    const content = await AboutPage();
    // Render the returned JSX
    render(content);
    // Verify that the page contains the expected text
    const aboutText = await screen.findByText("About Page");
    expect(aboutText).toBeInTheDocument();
  });
});
      