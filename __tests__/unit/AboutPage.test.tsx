import AboutPage from "@/app/about/page";
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

describe("AboutPage Component", () => {
  it("renders correctly and displays the updated About page text", async () => {
    const content = await AboutPage();
    render(content);
    const textElement = screen.getByText("This is the About Page");
    expect(textElement).toBeInTheDocument();
  });
});
