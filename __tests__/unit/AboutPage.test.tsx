import React from 'react';
import AboutPage from "@/app/about/page";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

describe("AboutPage Component", () => {
  it("renders correctly and displays 'This is the About Page'", async () => {
    const content = await AboutPage();
    render(content);
    const headingElement = screen.getByText("This is the About Page");
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
