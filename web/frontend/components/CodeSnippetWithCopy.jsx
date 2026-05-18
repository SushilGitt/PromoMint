import React, { useState } from "react";
import "./CodeSnippet.css";

const CodeBlock = ({ children }) => (
  <pre className="code-sinppet">
    <code>{children.trim()}</code>
  </pre>
);

const QuickSetupGuide = () => {
  const [copied, setCopied] = useState({});

  const codeSnippets = {
    embed: `
      // Step 1: Enable the app embed by adding the app embed code to the theme's theme.liquid or using the Shopify App Embed feature.
    `,
    productPage: `
      <div class="move-to-wishlist-engine" data-product-handle="{{ card_product.handle }}"></div>
    `,
    headerIcon: `
      <div class="header-icon" data-url="/wishlist">Wishlist</div>
    `,
    wishlistPage: `
      // Step 4: Add a page named "wishlist" to your Shopify store to display the wishlist items
      // No code required here, just create a page named "wishlist"
    `,
    productGrid: `
    <!-- Start Move to wishlist product card code -->
      <div class="move-to-wishlist-engine" data-product-handle="{{ product.handle }}"></div>
    <!-- End Move to wishlist product card code -->  
    `,
    moveToWishlistButton: `
    <!-- Start Move to wishlist cart page/drawer code -->
      <div class="move-to-wishlist" data-handle="{{ item.product.handle }}" data-id="{{ item.variant_id }}"></div>
    <!-- End Move to wishlist cart page/drawer code -->  
    `,
  };

  const copyIcon = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      height="28px"
      viewBox="0 -960 960 960"
      width="28px"
      fill="#fff"
    > <g transform="scale(1, 1)">
    <path d="M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm160-240v-480 480Z" />
    </g>
    </svg>
  );

  const copiedIcon = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      height="28px"
      viewBox="0 -960 960 960"
      width="28px"
      fill="#f5f5f5"
    >  <g transform="scale(0.9, 0.9)">
      <path d="M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm160-240v-480 480Z" />
      </g>
    </svg>
  );

  const handleCopy = (key) => {
    navigator.clipboard.writeText(codeSnippets[key].trim());
    setCopied((prev) => ({ ...prev, [key]: true }));
    setTimeout(() => setCopied((prev) => ({ ...prev, [key]: false })), 300);
  };

  return (
    <div className="setup-guide-container">
      <h2>Quick Setup for Application</h2>

     <div className='whishlist-basic-setup'>
      <h4>Basic App Steup</h4>
      <div className='instruction-points'>
        <h3>1. Enable the App Embed</h3>
        <p>
          Go to your Shopify theme editor and enable the app embed feature to integrate the app into your store.
        </p>
        <img src="https://cdn.shopify.com/s/files/1/0571/4372/2059/files/Screenshot_2024-12-18_113455.png?v=1734502090"/>
        <div>
        </div>
      </div>

      <div className='instruction-points'>
        <h3>2. Add the Block to the Product Page</h3>
        <p>
        Add the provided block to your product page to enable the wishlist functionality on individual product pages.
      </p>
        <img src="https://cdn.shopify.com/s/files/1/0571/4372/2059/files/Screenshot_2024-12-18_113539.png?v=1734502090"/>
      </div>
     </div>
     
     <div className='whishlist-adavance-setup'>
      <h4>Adavance App Setup</h4>
      <div className='instruction-points'>
        <h3>1. Add the Header Icon Using the Block "header-icon"</h3>
        <p>
          Use the "header-icon" block to display a wishlist icon in the store's header for quick access.
        </p>
        <img src="https://cdn.shopify.com/s/files/1/0571/4372/2059/files/Screenshot_2024-12-18_113628.png?v=1734502090"/>
      </div>

      <div className='instruction-points'>
        <h3>2. Add a Separate Wishlist Page</h3>
        <p>
          Create a new page named 'wishlist' in your Shopify store to serve as the dedicated wishlist page. This page will display all the products added to the wishlist.
        </p>
        <img src="https://cdn.shopify.com/s/files/1/0571/4372/2059/files/0_wishlist_page.png?v=1734429624"/>

        <h3>After create page add block "Wishlist Product Page".</h3>
        <img src="https://cdn.shopify.com/s/files/1/0571/4372/2059/files/Screenshot_2024-12-18_113710.png?v=1734502090"/>
      </div>

      <div className='instruction-points'>
        <h3>3. Add the Product Grid Code to Show the Wishlist Icon</h3>
        <p>
          In your product grid template, add the following code to show the wishlist icon:
        </p>
        <div className="copy-code-flex">
          <CodeBlock>{codeSnippets.productGrid}</CodeBlock>
          <button onClick={() => handleCopy('productGrid')} className="code-sinppet-btn">
              {copied.productGrid ? copiedIcon : copyIcon }
          </button>
        </div>  
        <div>
          
        </div>
        <img src="https://cdn.shopify.com/s/files/1/0571/4372/2059/files/grid-icon_1e9e6020-74a0-4800-89ef-59ba871d2456.png?v=1734333381" />
        <img src="https://cdn.shopify.com/s/files/1/0571/4372/2059/files/code_for_product_card.png?v=1734332919" />
      </div>

      <div className='instruction-points'>
        <h3>4. Add Code for the "Move to Wishlist" Button in the Cart</h3>
        <p>
          In your cart template, add the following code to display the "Move to Wishlist" button:
        </p>
        <div className="copy-code-flex">
          <CodeBlock>{codeSnippets.moveToWishlistButton}</CodeBlock>
          <button onClick={() => handleCopy('moveToWishlistButton')} className="code-sinppet-btn">
              {copied.moveToWishlistButton ? copiedIcon : copyIcon }
          </button>
        </div>
        <div>
          
        </div>
        <img src="https://cdn.shopify.com/s/files/1/0571/4372/2059/files/move_to_wishlist_btn.png?v=1734334040" />
        <img src="https://cdn.shopify.com/s/files/1/0571/4372/2059/files/Screenshot_2024-12-16_130934.png?v=1734334876" />
      </div>
    </div>
    </div>
  );
};

export default QuickSetupGuide;
