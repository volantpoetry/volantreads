// return-url-handler.js
// Handles return URL functionality across all pages

(function() {
    'use strict';
    
    // Configuration
    const CONFIG = {
        authPages: ['login', 'signup', 'verify', 'reset', 'check-verification'],
        defaultReturnUrl: '/index.html',
        storageKey: 'returnUrl'
    };
    
    // Get return URL from various sources
    function getReturnUrl() {
        // 1. Check URL parameters first
        const urlParams = new URLSearchParams(window.location.search);
        let returnUrl = urlParams.get('returnUrl') || urlParams.get('redirect');
        
        // 2. Check session storage
        if (!returnUrl) {
            returnUrl = sessionStorage.getItem(CONFIG.storageKey);
        }
        if (!returnUrl) {
            returnUrl = sessionStorage.getItem('redirect');
        }
        if (!returnUrl) {
            returnUrl = sessionStorage.getItem('preLoginPage');
        }
        
        // 3. Check localStorage
        if (!returnUrl) {
            returnUrl = localStorage.getItem(CONFIG.storageKey);
        }
        if (!returnUrl) {
            returnUrl = localStorage.getItem('redirect');
        }
        
        // 4. Check referrer
        if (!returnUrl || returnUrl === 'null' || returnUrl === 'undefined') {
            returnUrl = document.referrer || CONFIG.defaultReturnUrl;
        }
        
        // Clean up
        if (returnUrl && returnUrl !== 'null' && returnUrl !== 'undefined') {
            try {
                returnUrl = decodeURIComponent(returnUrl);
            } catch (e) {}
            
            returnUrl = returnUrl.split('?')[0];
            returnUrl = returnUrl.split('#')[0];
            
            if (!returnUrl.startsWith('/') && !returnUrl.startsWith('http')) {
                returnUrl = '/' + returnUrl;
            }
            
            if (CONFIG.authPages.some(page => returnUrl.includes(page))) {
                returnUrl = CONFIG.defaultReturnUrl;
            }
        }
        
        return returnUrl || CONFIG.defaultReturnUrl;
    }
    
    // Set return URL
    function setReturnUrl(url) {
        if (url && !CONFIG.authPages.some(page => url.includes(page))) {
            sessionStorage.setItem(CONFIG.storageKey, url);
            sessionStorage.setItem('redirect', url);
            sessionStorage.setItem('preLoginPage', url);
            localStorage.setItem(CONFIG.storageKey, url);
            localStorage.setItem('redirect', url);
        }
    }
    
    // Clear return URL
    function clearReturnUrl() {
        sessionStorage.removeItem(CONFIG.storageKey);
        sessionStorage.removeItem('redirect');
        sessionStorage.removeItem('preLoginPage');
        localStorage.removeItem(CONFIG.storageKey);
        localStorage.removeItem('redirect');
    }
    
    // Redirect to return URL
    function redirectToReturnUrl() {
        const returnUrl = getReturnUrl();
        clearReturnUrl();
        window.location.href = returnUrl;
    }
    
    // Store current page
    function storeCurrentPage() {
        const currentPath = window.location.pathname + window.location.search + window.location.hash;
        if (currentPath && !CONFIG.authPages.some(page => currentPath.includes(page))) {
            setReturnUrl(currentPath);
        }
    }
    
    // Initialize
    function init() {
        console.log('✅ Return URL Handler initialized');
        
        const currentPath = window.location.pathname;
        if (CONFIG.authPages.some(page => currentPath.includes(page))) {
            const returnUrl = getReturnUrl();
            setReturnUrl(returnUrl);
        }
        
        document.addEventListener('click', function(e) {
            const link = e.target.closest('a');
            if (link) {
                const href = link.getAttribute('href');
                if (href && CONFIG.authPages.some(page => href.includes(page))) {
                    storeCurrentPage();
                }
            }
        });
        
        document.addEventListener('submit', function(e) {
            const form = e.target;
            if (form && form.action && CONFIG.authPages.some(page => form.action.includes(page))) {
                storeCurrentPage();
                
                let returnInput = form.querySelector('input[name="returnUrl"]');
                if (!returnInput) {
                    returnInput = document.createElement('input');
                    returnInput.type = 'hidden';
                    returnInput.name = 'returnUrl';
                    form.appendChild(returnInput);
                }
                returnInput.value = getReturnUrl();
            }
        });
        
        window.ReturnUrlHandler = {
            getReturnUrl: getReturnUrl,
            setReturnUrl: setReturnUrl,
            clearReturnUrl: clearReturnUrl,
            redirectToReturnUrl: redirectToReturnUrl,
            storeCurrentPage: storeCurrentPage
        };
        
        if (window.location.search.includes('auth=success')) {
            setTimeout(redirectToReturnUrl, 500);
        }
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
