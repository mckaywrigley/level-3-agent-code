import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"

function ExampleComponent() {
  return <button>Click Me</button>
}

describe("ExampleComponent", () => {
  it("renders a button with text 'Click Me'", () => {
    render(<ExampleComponent />)
    expect(screen.getByRole("button")).toHaveTextContent("Click Me")
  })
})
