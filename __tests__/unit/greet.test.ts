function greet(name: string) {
  return `Hello, ${name}!`
}

describe("greet utility", () => {
  it("greets a person by name", () => {
    expect(greet("Alice")).toBe("Hello, Alice!")
  })
})
