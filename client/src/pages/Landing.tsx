// Add global declaration for Telegram auth callback
declare global {
  interface Window {
    onTelegramAuth?: (user: any) => void;
  }
}
import { useAuth } from "@/hooks/useAuth";
import { useLocation, useParams } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useTheme } from "@/contexts/ThemeProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger, DialogContent, DialogClose, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { ThemeToggle } from "@/components/ThemeToggle";
import { motion } from "framer-motion";
import { Zap, DollarSign, Users, Trophy, Shield, Clock } from "lucide-react";
import { useEffect, useState } from "react";

export default function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const params = useParams();
  const { toast } = useToast();
  const { theme } = useTheme();
  const [isVisible, setIsVisible] = useState(false);
  const [referralCode, setReferralCode] = useState<string | null>(null);

  useEffect(() => {
    setIsVisible(true);

    // Extract referral code from URL
    if (params.code) {
      setReferralCode(params.code);
      localStorage.setItem('referralCode', params.code);
      toast({
        title: "Referral Code Applied!",
        description: `You'll get bonus rewards when you sign up with code: ${params.code}`,
      });
    }

    if (isAuthenticated) {
      setLocation('/');
    }
  }, [isAuthenticated, setLocation, params.code, toast]);

  const [open, setOpen] = useState(false);

  // Telegram login widget integration
  useEffect(() => {
    if (!open) return;
    const container = document.getElementById('telegram-login-container');
    if (container) container.innerHTML = '';
    // Fallback message if widget fails
    let fallbackTimeout: NodeJS.Timeout;
    window.onTelegramAuth = function(user) {
      fetch('/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user)
      })
      .then(res => res.json())
      .then(data => {
        toast({ title: 'Telegram Login', description: 'Welcome, ' + data.first_name });
        setOpen(false);
      });
    };
    // Load Telegram widget script
    const botUsername = 'BantahSocialBot'; // <-- Update this if needed
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?7';
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-userpic', 'false');
    script.setAttribute('data-request-access', 'write');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    container?.appendChild(script);
    // Fallback if widget doesn't render
    fallbackTimeout = setTimeout(() => {
      if (container && container.innerHTML.trim() === '') {
        container.innerHTML = `<div class='text-red-600 text-center mt-2'>Telegram login widget failed to load.<br/>Check your bot username or try again later.</div>`;
      }
    }, 3000);
    // Cleanup on close
    return () => {
      if (container) container.innerHTML = '';
      delete window.onTelegramAuth;
      clearTimeout(fallbackTimeout);
    };
  }, [open, toast]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 theme-transition">
      {/* Header */}
      <nav className="bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 theme-transition">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-gradient-to-br from-primary to-secondary rounded-lg flex items-center justify-center">
                <i className="fas fa-dice text-white text-sm"></i>
              </div>
              <span className="text-xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
                BetChat
              </span>
            </div>
            <div className="flex items-center space-x-4">
              <ThemeToggle />
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button className="bg-primary hover:bg-primary/90">Sign In</Button>
              </DialogTrigger>
              <DialogContent className="max-w-md mx-auto">
                <DialogTitle className="text-xl font-bold mb-4">Sign In</DialogTitle>
                <DialogDescription className="mb-4 text-slate-600 dark:text-slate-400">
                  Choose a sign-in method below. Your data is secure.
                </DialogDescription>
                <div className="mb-2 text-center text-blue-600 font-medium">Sign in with Telegram below:</div>
                <div id="telegram-login-container" className="mt-4"></div>
                {/* Add other auth options here */}
                <DialogClose asChild>
                  <Button variant="outline" className="w-full">Cancel</Button>
                </DialogClose>
              </DialogContent>
            </Dialog>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <div className="text-center">
          <h1 className="text-4xl md:text-6xl font-bold text-slate-900 dark:text-slate-100 mb-6">
            Social Betting & 
            <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
              {" "}Challenges
            </span>
          </h1>
          <p className="text-xl text-slate-600 dark:text-slate-400 mb-8 max-w-3xl mx-auto">
            Join the ultimate social betting platform. Predict events, challenge friends, 
            and win big while having fun with real-time chat and gamification.
          </p>
          {referralCode && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="bg-gradient-to-r from-green-500/20 to-blue-500/20 border border-green-500/30 rounded-xl p-4 mb-6"
              >
                <div className="text-center">
                  <p className="text-sm font-medium text-green-600 dark:text-green-400">
                    🎁 Referral Code Applied: <span className="font-bold">{referralCode}</span>
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                    You'll get bonus rewards when you sign up!
                  </p>
                </div>
              </motion.div>
            )}

            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: isVisible ? 1 : 0, y: isVisible ? 0 : 20 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="flex flex-col sm:flex-row gap-4 justify-center mt-8"
            >
              <Button 
                size="lg" 
                className="bg-[#7440ff] hover:bg-[#5f35cc] text-white px-8 py-3 rounded-full font-semibold text-lg shadow-lg hover:shadow-xl transition-all duration-300 transform hover:scale-105"
                onClick={() => setOpen(true)}
              >
                {referralCode ? 'Sign Up with Bonus' : 'Get Started Free'}
                <Zap className="ml-2 h-5 w-5" />
              </Button>

              <Button 
                variant="outline" 
                size="lg" 
                className="border-2 border-[#7440ff] text-[#7440ff] hover:bg-[#7440ff] hover:text-white px-8 py-3 rounded-full font-semibold text-lg transition-all duration-300"
              >
                Learn More
              </Button>
            </motion.div>
        </div>

        {/* Feature Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-20">
          <Card className="bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <CardContent className="p-6 text-center">
              <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mx-auto mb-4">
                <i className="fas fa-calendar text-primary text-xl"></i>
              </div>
              <h3 className="text-xl font-semibold mb-2">Event Predictions</h3>
              <p className="text-slate-600 dark:text-slate-400">
                Bet on crypto, sports, gaming, music, and political events with real-time pools.
              </p>
            </CardContent>
          </Card>

          <Card className="bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <CardContent className="p-6 text-center">
              <div className="w-12 h-12 bg-secondary/10 rounded-lg flex items-center justify-center mx-auto mb-4">
                <i className="fas fa-swords text-secondary text-xl"></i>
              </div>
              <h3 className="text-xl font-semibold mb-2">P2P Challenges</h3>
              <p className="text-slate-600 dark:text-slate-400">
                Challenge friends directly with escrow protection and evidence-based results.
              </p>
            </CardContent>
          </Card>

          <Card className="bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <CardContent className="p-6 text-center">
              <div className="w-12 h-12 bg-emerald-500/10 rounded-lg flex items-center justify-center mx-auto mb-4">
                <i className="fas fa-comments text-emerald-500 text-xl"></i>
              </div>
              <h3 className="text-xl font-semibold mb-2">Live Chat</h3>
              <p className="text-slate-600 dark:text-slate-400">
                Real-time messaging, typing indicators, and social features for maximum engagement.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Stats */}
        <div className="bg-gradient-to-br from-primary to-secondary rounded-2xl p-8 mt-20 text-white">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
            <div>
              <div className="text-4xl font-bold mb-2">10K+</div>
              <div className="text-primary-100">Active Users</div>
            </div>
            <div>
              <div className="text-4xl font-bold mb-2">₦2.5M+</div>
              <div className="text-primary-100">Total Volume</div>
            </div>
            <div>
              <div className="text-4xl font-bold mb-2">5K+</div>
              <div className="text-primary-100">Events Created</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}