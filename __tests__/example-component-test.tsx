// __tests__/example-component.test.tsx
import { render, screen } from "@testing-library/react"
// If you haven't yet installed Testing Library, run:
// npm install --save-dev @testing-library/react @testing-library/jest-dom
import "@testing-library/jest-dom"

function ExampleComponent() {
  return <button>Click Me</button>
}

describe("ExampleComponent", () => {
  it("renders a button with text 'Click Me'", () => {
    render(<ExampleComponent />)
    expect(screen.getByRole("button")).toHaveTextContent("Click Me")
  })
})
