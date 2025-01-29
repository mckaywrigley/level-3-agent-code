function sum(a: number, b: number) {
  return a + b
}

describe("sum utility", () => {
  test("adds two positive numbers", () => {
    expect(sum(2, 3)).toBe(5)
  })

  test("adds a positive and a negative number", () => {
    expect(sum(5, -2)).toBe(3)
  })
})
