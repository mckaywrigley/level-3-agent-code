
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import ExampleComponent from "@/components/ExampleComponent";

describe("ExampleComponent", () => {
  it("renders a button with text 'Click Me'", () => {
    render(<ExampleComponent />);
    const button = screen.getByRole("button", { name: "Click Me" });
    expect(button).toBeInTheDocument();
  });
});
      