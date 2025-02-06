import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

// Updated test to check for the new About page text

describe("AboutPage Component", () => {
  it("renders correctly and displays the updated About page text", async () => {
    const content = await AboutPage();
    render(content);
    const headingElement = screen.getByText("About Page");
    expect(headingElement).toBeInTheDocument();
  });

  it("optionally renders a comment section if present", async () => {
    const content = await AboutPage();
    render(content);
    const commentSection = screen.queryByTestId("comment-section");
    if (commentSection) {
      expect(commentSection).toBeInTheDocument();
    }
  });
});