
import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

describe("AboutPage", () => {
  it("renders AboutPage with the correct text", async () => {
    const content = await AboutPage();
    render(content);
    await waitFor(() => {
      expect(screen.getByText("About Page")).toBeInTheDocument();
    });
  });
});
      