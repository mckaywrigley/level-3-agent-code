
/* E2E test for About Navigation with added comments */
// This end-to-end test verifies that the application's navigation works as expected,
// ensuring that clicking the "About" link navigates to the About page.
describe("About Navigation", () => {
  it("should navigate to the About page when the About link is clicked", () => {
    // Visit the home page.
    cy.visit("/");
    // Find the navigation element and click on the "About" link.
    cy.get("nav").contains("About").click();
    // Verify that the URL includes "/about" indicating the correct navigation.
    cy.url().should("include", "/about");
    // Check that the About page displays the text "About Page".
    cy.contains("About Page").should("be.visible");
  });
});
