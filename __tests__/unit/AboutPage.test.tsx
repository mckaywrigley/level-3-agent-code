import AboutPage from "@/app/about/page"
import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"

describe("AboutPage Component", () => {
  it("renders correctly and displays the About page text", async () => {
    const content = await AboutPage()
    render(content)
    const headingElement = screen.getByText("This is the About Page")
    expect(headingElement).toBeInTheDocument()
  })

  it("optionally renders a comment section if present", async () => {
    const content = await AboutPage()
    render(content)
    const commentSection = screen.queryByTestId("comment-section")
    if (commentSection) {
      expect(commentSection).toBeInTheDocument()
    }
  })
})
