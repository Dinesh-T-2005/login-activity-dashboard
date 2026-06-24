import {
  Component,
  OnInit,
  AfterViewInit,
  ViewChild,
  ElementRef,
  OnDestroy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivityServiceService } from '../activity-service.service';
import { EncryptedCookieService } from 'src/app/services/encrypted-cookie.service';
import { myprofileService } from 'src/app/pages/MyProfile/myprofile.service';
import { MaterialModule } from "src/app/material.module";
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';



interface userdivision {
  division: string;
}



@Component({
  selector: 'app-login-activity',
  standalone: true,
  imports: [CommonModule, MaterialModule, FormsModule],
  templateUrl: './login-activity.component.html',
  styleUrls: ['./login-activity.component.scss']
})
export class LoginActivityComponent implements OnInit, AfterViewInit, OnDestroy {

  todayData: any;
  sessions: any[] = [];
  status = 'Logged Out';

  userid: number;
  private viewReady = false;
  private timer!: any;

  timeLabels: string[] = [];

  tooltip = {
    show: false,
    text: '',
    left: 0,
    top: 0
  };

  adminForm: userdivision = {

    division: '',
  };

  divisionStats: any[] = [];
  divisionId: any;

  @ViewChild('chartCanvas')
  chartCanvas!: ElementRef<HTMLElement>;
  userdivision: any;
  divisionList: any;
  accesstype: any;
  orgid: any;
  divisionUsers: any[] = [];

  constructor(
    private activityService: ActivityServiceService,
    private encryptedCookieService: EncryptedCookieService,
    private myprofileService: myprofileService,
    private route: Router,
  ) {
    this.userid = Number(this.encryptedCookieService.getCookie('userId'));
    this.divisionId = this.encryptedCookieService.getCookie('divisionId') || '';
    this.accesstype = this.encryptedCookieService.getCookie('AccessType');
    this.orgid = this.encryptedCookieService.getCookie('orgId');
  }

  ngOnInit(): void {
    this.loadTodayActivity();
    if (this.accesstype !== 3) {
      this.onDivisionChange();
    }


    // 🔥 LIVE UPDATE EVERY MINUTE
    this.timer = setInterval(() => {
      if (this.sessions.length && this.viewReady) {
        this.renderChart();
      }
    }, 1000);
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    if (this.sessions.length) this.renderChart();
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  loadTodayActivity(): void {
    this.activityService.getTodayActivity(this.userid).subscribe(res => {
      this.todayData = res;
      this.sessions = res?.sessions || [];
      this.status = res?.isActive ? 'Active' : 'Logged Out';

      if (this.viewReady) this.renderChart();
    });
  }

  /** hh:mm AM/PM → minutes */
  private timeToMinutes(timeStr: string): number {
    if (!timeStr) return 0;
    timeStr = timeStr.replace(/\s+/g, ' ').trim();

    const [time, period] = timeStr.split(' ');
    const [h, m] = time.split(':').map(Number);

    let hours = h;
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;

    return hours * 60 + m;
  }

  private minutesToLabel(min: number): string {
    let h = Math.floor(min / 60);
    const m = min % 60;
    const period = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m.toString().padStart(2, '0')} ${period}`;
  }

  /** 🔥 MAIN CHART LOGIC */
  private renderChart(): void {
    if (!this.chartCanvas || !this.sessions.length) return;

    const canvas = this.chartCanvas.nativeElement;
    canvas.querySelectorAll('.session-bar').forEach(b => b.remove());

    const lastSessions = this.sessions.slice(-3);

    const nowMinutes = this.timeToMinutes(
      new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      })
    );

    const times: number[] = [];
    lastSessions.forEach(s => {
      times.push(this.timeToMinutes(s.login));
      times.push(s.logout ? this.timeToMinutes(s.logout) : nowMinutes);
    });

    const minTime = Math.min(...times) - 5;
    const maxTime = Math.max(...times) + 5;
    const total = maxTime - minTime || 1;

    /* 🔹 Dynamic Time Labels */
    const step = Math.floor(total / 4);
    this.timeLabels = [];
    for (let i = 0; i <= 4; i++) {
      this.timeLabels.push(this.minutesToLabel(minTime + step * i));
    }

    lastSessions.forEach((session, index) => {

      const login = this.timeToMinutes(session.login);
      const logout = session.logout
        ? this.timeToMinutes(session.logout)
        : nowMinutes;

      const left = ((login - minTime) / total) * 100;
      const width = Math.max(((logout - login) / total) * 100, 6);

      const bar = document.createElement('div');

      bar.style.position = 'absolute';
      bar.style.height = '32px';
      bar.style.borderRadius = '8px';
      bar.style.zIndex = '2';
      bar.style.left = `${left}%`;
      bar.style.width = `${width}%`;
      bar.style.top = `${index * 36 + 20}px`;

      if (session.isActive) {
        bar.style.background = '#16a34a';
        // bar.style.boxShadow = '0 0 5px rgba(22,163,74,1)';

        // bar.animate(
        //   [
        //     { boxShadow: '0 0 6px rgba(22,163,74,0.6)' },
        //     { boxShadow: '0 0 16px rgba(22,163,74,1)' },
        //     { boxShadow: '0 0 6px rgba(22,163,74,0.6)' }
        //   ],
        //   {
        //     duration: 1500,
        //     iterations: Infinity
        //   }
        // );
      }

      else {
        bar.style.background = '#3b82f6'; // ✅ BLUE (completed)
      }

      /* 🔥 TOOLTIP */
      bar.addEventListener('mouseenter', (e: any) => {
        this.tooltip.show = true;
        this.tooltip.text =
          `${session.login} → ${session.logout || 'Active'} (${session.duration})`;
        this.tooltip.left = e.clientX + 10;
        this.tooltip.top = e.clientY - 20;
      });

      bar.addEventListener('mouseleave', () => {
        this.tooltip.show = false;
      });

      canvas.appendChild(bar);
    });

  }


  onDivisionChange(): void {
    this.activityService.getDivisionRecruiterStats(this.divisionId, this.accesstype, this.orgid).subscribe({
      next: (res) => this.divisionStats = res.data, // 👈 use .data
      error: () => console.error('Error fetching division recruiter stats')
    });
  }


  userDivisionChange(divisionId: string): void {

    this.divisionId = divisionId;


    this.activityService
      .getDivisionRecruiterStatsNew(divisionId, this.userid)
      .subscribe({
        next: (res) => {
          // if API returns { success, data }
          this.divisionUsers = res.data || res;

        },
        error: (err) => {
          console.error('Error fetching division recruiter stats', err);
        }
      });
  }



  isUserOnline(user: any): boolean {
    if (!user.loginlogout) return false;

    try {
      const data = JSON.parse(user.loginlogout);
      const today = new Date().toISOString().split('T')[0];

      const todayData = data.find((d: any) => d.date === today);
      if (!todayData || !todayData.sessions.length) return false;

      // ✅ TAKE LAST SESSION ONLY
      const lastSession = todayData.sessions[todayData.sessions.length - 1];

      return lastSession.isActive === true && !lastSession.logout;

    } catch (e) {
      console.error('Invalid loginlogout JSON', e);
      return false;
    }
  }


  getTodaySessionCount(user: any): number {
    if (!user.loginlogout) return 0;

    try {
      const data = JSON.parse(user.loginlogout);
      const today = new Date().toISOString().split('T')[0];

      const todayData = data.find((d: any) => d.date === today);
      if (!todayData || !todayData.sessions) return 0;

      return todayData.sessions.length;
    } catch {
      return 0;
    }
  }

  isRecruiter(): boolean {
    return Number(this.accesstype) === 3;
  }

  viewUserActivity(user: any): void {
    const userId = user.userId;
    if (!userId) {
      return;
    }
    const payload = { userId };

    this.route.navigate(['/ats/login-history', userId], { state: payload });
  }

  toggleStatusTooltip(): void {
    this.userDivisionChange(this.divisionId);
  }

}